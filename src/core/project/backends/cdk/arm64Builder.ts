/**
 * Checks that the local container builder can produce Linux ARM64 images before a
 * ContainerLocal deploy. AgentCore runs ARM64 images only, and an x86 builder
 * without emulation fails late (mid-deploy, after credential providers exist) or,
 * worse, publishes an image that cannot start. The check never installs emulation
 * or provisions a builder; it only reports what to fix.
 *
 * In order:
 *  1. `<builder> info`: a native linux/arm64 daemon builds ARM64 directly, and
 *     the check passes. Docker and Finch report OSType/Architecture; Podman
 *     reports host.os/host.arch. Unreadable info is not fatal: the probe decides.
 *  2. `<builder> buildx inspect`: read for the active builder's name, driver, and
 *     platforms, which go into warnings and the error message. A listed
 *     linux/arm64 is not proof: a builder can keep advertising a platform whose
 *     emulation is gone (binfmt lost after a reboot, a builder cached in CI).
 *  3. An execution probe, on every non-ARM64 daemon: build a scratch image whose
 *     only step runs a tiny ARM64 program. This covers builders without buildx
 *     (Finch, Podman) and proves emulation (binfmt/QEMU) actually executes ARM64
 *     code. It uses --network none and --no-cache, so it downloads nothing.
 *
 * The probe's build context lives in the project's agentcore/.cli/ directory, not
 * the OS temp directory: VM-backed builders (Finch, Podman machine, Docker Desktop)
 * share only some host paths, typically the home directory, and on macOS the temp
 * directory is outside it. agentcore/.cli/ is git-ignored and excluded from build
 * contexts, and the directory is removed afterwards.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ProjectStateError } from "../../../../errors";
import type { ProcessRunner } from "../../../../io";

const REMEDIATION =
  "Use an ARM64 machine or CI runner, or enable ARM64 emulation for your builder " +
  "(for Docker: enable buildx and install QEMU binfmt handlers, e.g. " +
  "'docker run --privileged --rm tonistiigi/binfmt --install arm64'). " +
  "Set CDK_DOCKER to choose a different Docker-compatible builder.";

// The probe program: a 132-byte static Linux ELF64 executable for AArch64 with a
// single read/execute segment and entry point 0x400078. Its three instructions,
//   mov x0, #0; mov x8, #93; svc #0
// make the Linux exit(0) syscall. It needs no shell, libraries, or base image.
const ARM64_EXECUTION_PROBE = Buffer.from(
  [
    "7f454c460201010000000000000000000200b700010000007800400000000000",
    "4000000000000000000000000000000000000000400038000100000000000000",
    "0100000005000000000000000000000000004000000000000000400000000000",
    "840000000000000084000000000000000010000000000000",
    "000080d2a80b80d2010000d4",
  ].join(""),
  "hex",
);

/** Runs the probe; on failure, throws with the probe's output attached as `output`. */
async function probeArm64Execution(
  runner: ProcessRunner,
  cwd: string,
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<void> {
  const parent = join(cwd, "agentcore", ".cli");
  mkdirSync(parent, { recursive: true });
  const context = mkdtempSync(join(parent, "arm64-probe-"));
  let output = "";
  try {
    // Create the export directory ourselves so a builder running as root cannot own it.
    mkdirSync(join(context, "output"));
    writeFileSync(join(context, "arm64-check"), ARM64_EXECUTION_PROBE);
    writeFileSync(
      join(context, "Dockerfile"),
      'FROM scratch\nCOPY --chmod=0555 arm64-check /arm64-check\nRUN ["/arm64-check"]\n',
    );
    await runner(
      [
        executable,
        "build",
        "--platform",
        "linux/arm64",
        "--network",
        "none",
        "--no-cache",
        "--output",
        "type=local,dest=output",
        "--file",
        "Dockerfile",
        ".",
      ],
      {
        cwd: context,
        ...(env && { env }),
        signal: AbortSignal.timeout(60_000),
        onOutput: (chunk) => {
          output += chunk;
        },
      },
    );
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { output });
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
}

const QUERY_TIMEOUT_MS = 30_000;

async function capture(
  runner: ProcessRunner,
  command: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  let output = "";
  await runner(command, {
    cwd,
    ...(env && { env }),
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    onOutput: (chunk) => {
      output += chunk;
    },
  });
  return output;
}

type Daemon = { os: string; arch: string };

/** Reads OS and architecture from Docker/Finch (OSType, Architecture) or Podman (host.os, host.arch) info. */
function parseDaemon(info: string): Daemon | undefined {
  // Output mixes stdout and stderr, and Finch can print startup lines before its
  // single-line JSON, so try the whole output and then each line from the end.
  for (const candidate of [info.trim(), ...info.trim().split(/\r?\n/).reverse()]) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.OSType === "string" && typeof record.Architecture === "string") {
      return { os: record.OSType, arch: record.Architecture };
    }
    const host = record.host as Record<string, unknown> | undefined;
    if (typeof host?.os === "string" && typeof host.arch === "string") {
      return { os: host.os, arch: host.arch };
    }
  }
  return undefined;
}

/** The active buildx builder, as `buildx inspect` reports it. */
export type BuildxBuilder = { name?: string; driver?: string };

/** What the check learned about the builder, for the image build and its warnings. */
export type Arm64BuilderReport = { buildx?: BuildxBuilder };

export type Arm64BuilderCheckOptions = {
  /**
   * Set as BUILDX_BUILDER for every command the check runs, so `buildx inspect`
   * and the probe describe the builder the deploy hands to CDK.
   */
  buildxBuilder?: string;
};

function parseBuildx(output: string): BuildxBuilder {
  // The first Name: line is the builder; later ones name its nodes.
  return {
    name: /^Name:\s*(\S+)/m.exec(output)?.[1],
    driver: /^Driver:\s*(\S+)/m.exec(output)?.[1],
  };
}

/** A short reason from the probe's output, preferring the error that means "no ARM64 emulation". */
function probeFailureReason(error: unknown): string {
  const output = (error as { output?: string }).output ?? "";
  if (/exec format error/i.test(output)) return "exec format error";
  const last = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  const reason = last ?? (error instanceof Error ? error.message : String(error));
  return reason.length > 200 ? `${reason.slice(0, 200)}…` : reason;
}

/**
 * Throws a {@link ProjectStateError} that says what was found and how to fix it
 * unless `executable` can build Linux ARM64 images.
 */
export async function checkArm64Builder(
  runner: ProcessRunner,
  cwd: string,
  executable: string,
  options: Arm64BuilderCheckOptions = {},
): Promise<Arm64BuilderReport> {
  const env = options.buildxBuilder
    ? { ...process.env, BUILDX_BUILDER: options.buildxBuilder }
    : undefined;
  let info: string;
  try {
    info = await capture(runner, [executable, "info", "--format", "{{json .}}"], cwd, env);
  } catch {
    throw new ProjectStateError(
      `Cannot access the container builder '${executable}'. Check that it is installed and ` +
        "its daemon or VM is running. Set CDK_DOCKER to choose a different Docker-compatible builder.",
    );
  }
  const daemon = parseDaemon(info);

  // Podman's `buildx` is an alias for `build` with no inspect, so it is never asked.
  let buildx: BuildxBuilder | undefined;
  let platforms: string[] = [];
  if (!basename(executable).startsWith("podman")) {
    try {
      const output = await capture(runner, [executable, "buildx", "inspect"], cwd, env);
      buildx = parseBuildx(output);
      platforms = [...output.matchAll(/^\s*Platforms:\s*(.+)$/gm)].flatMap((match) =>
        match[1]!.split(",").map((platform) => platform.trim().replace(/\*$/, "")),
      );
    } catch {
      // Finch and others need not implement buildx; the probe below decides.
    }
  }
  const report = { ...(buildx && { buildx }) };
  if (daemon?.os === "linux" && ["arm64", "aarch64"].includes(daemon.arch)) return report;
  const listsArm64 = platforms.includes("linux/arm64") || platforms.includes("linux/arm64/v8");

  try {
    await probeArm64Execution(runner, cwd, executable, env);
    return report;
  } catch (error) {
    const found = [
      daemon ? `daemon ${daemon.os}/${daemon.arch}` : "daemon architecture unknown",
      buildx
        ? `buildx builder '${buildx.name ?? "unknown"}' (driver ${buildx.driver ?? "unknown"}) ` +
          (listsArm64 ? "lists linux/arm64 but cannot run ARM64 code" : "does not list linux/arm64")
        : "no buildx",
      `ARM64 test build failed: ${probeFailureReason(error)}`,
    ].join("; ");
    throw new ProjectStateError(
      `The container builder '${executable}' cannot build Linux ARM64 images, which ` +
        `ContainerLocal requires. Found: ${found}. ${REMEDIATION}`,
      { cause: error },
    );
  }
}

/**
 * Whether ContainerLocal deploys must redirect Docker to a docker-driver builder.
 * CDK publishes with a plain `docker build` (no --load), so a builder whose driver
 * is not `docker` (docker-container, kubernetes, remote; what
 * docker/setup-buildx-action creates) keeps the image out of the local store and
 * the push fails with "No such image". Only Docker reads BUILDX_BUILDER.
 */
export function needsDockerDriverBuilder(
  executable: string,
  builder: BuildxBuilder | undefined,
): boolean {
  const driver = builder?.driver;
  return basename(executable).startsWith("docker") && !!driver && driver !== "docker";
}

function driverWarningPrefix(builder: BuildxBuilder): string {
  return (
    `The active buildx builder '${builder.name ?? "unknown"}' uses the ${builder.driver} driver, ` +
    "which does not load the images it builds into the local Docker image store that CDK pushes from."
  );
}

/** The BUILDX_BUILDER a ContainerLocal deploy builds with, and a warning to show. */
export type BuildxBuilderSelection = { buildxBuilder?: string; warning?: string };

// Docker context names: a letter or digit, then letters, digits, `_`, `.`, `+`, `-`.
const CONTEXT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/;

/**
 * Chooses the builder a ContainerLocal deploy builds and publishes with, before the
 * ARM64 check runs on it. When the executable is Docker and the active buildx
 * builder's driver is not `docker`, the deploy is redirected to the docker-driver
 * builder of the active Docker context: every context has one, named after the
 * context (`docker context show`). BUILDX_BUILDER=default would instead select the
 * `default` context's builder, which on Docker Desktop, Colima, Rancher Desktop,
 * or an ssh context is a different daemon. If the context cannot be read, nothing
 * is redirected and the warning says so.
 */
export async function selectBuildxBuilder(
  runner: ProcessRunner,
  cwd: string,
  executable: string,
): Promise<BuildxBuilderSelection> {
  if (!basename(executable).startsWith("docker")) return {};
  let active: BuildxBuilder;
  try {
    active = parseBuildx(await capture(runner, [executable, "buildx", "inspect"], cwd));
  } catch {
    // Without buildx, plain `docker build` uses the daemon's builder; nothing to redirect.
    return {};
  }
  if (!needsDockerDriverBuilder(executable, active)) return {};

  let context: string | undefined;
  let reason = "it printed no context name";
  try {
    const output = await capture(runner, [executable, "context", "show"], cwd);
    const last = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();
    if (last && CONTEXT_NAME.test(last)) context = last;
    else if (last) reason = `it printed '${last.length > 80 ? `${last.slice(0, 80)}…` : last}'`;
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  if (!context) {
    return {
      warning:
        `${driverWarningPrefix(active)} The deploy could not read the active Docker context ` +
        `('${executable} context show' failed: ${reason}), so it builds with ` +
        `'${active.name ?? "the active builder"}' unchanged and the CDK push can fail. ` +
        "Run 'docker buildx use <context>' with the name 'docker context show' prints to " +
        "switch to the docker driver.",
    };
  }
  return {
    buildxBuilder: context,
    warning:
      `${driverWarningPrefix(active)} ContainerLocal deploys therefore build and publish with ` +
      `'${context}', the docker-driver builder of the active Docker context, by setting ` +
      `BUILDX_BUILDER=${context} for the deploy.`,
  };
}

/**
 * A warning when the active Docker buildx builder's driver is not `docker`: images
 * it builds may not be loaded into the local image store, so CDK's push can fail.
 * For Docker, deploys avoid that by building with the active Docker context's
 * docker-driver builder instead (see {@link selectBuildxBuilder}).
 */
export function buildxDriverWarning(
  report: Arm64BuilderReport,
  executable = "docker",
): string | undefined {
  const builder = report.buildx;
  if (!builder?.driver || builder.driver === "docker") return undefined;
  const prefix = driverWarningPrefix(builder);
  if (needsDockerDriverBuilder(executable, builder)) {
    return (
      `${prefix} ContainerLocal deploys therefore build and publish with the docker-driver ` +
      "builder of the active Docker context instead, by setting BUILDX_BUILDER for the deploy."
    );
  }
  return `${prefix} The CDK push can fail. Run 'docker buildx use default' to switch to the docker driver.`;
}
