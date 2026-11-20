/**
 * Checks that the local container builder can produce Linux ARM64 images before a
 * ContainerLocal deploy. AgentCore runs ARM64 images only, and an x86 builder
 * without emulation fails late (mid-deploy, after credential providers exist) or,
 * worse, publishes an image that cannot start. The check never installs emulation
 * or provisions a builder; it only reports what to fix.
 *
 * In order, the first that succeeds wins:
 *  1. `<builder> info`: a native linux/arm64 daemon builds ARM64 directly. Docker
 *     and Finch report OSType/Architecture; Podman reports host.os/host.arch.
 *     Unreadable info is not fatal: the later checks decide.
 *  2. `<builder> buildx inspect`: the active builder lists linux/arm64.
 *  3. An execution probe: build a scratch image whose only step runs a tiny ARM64
 *     program. This covers builders without buildx (Finch, Podman) and proves
 *     emulation (binfmt/QEMU) actually executes ARM64 code, not just that it is
 *     advertised. It uses --network none and --no-cache, so it downloads nothing.
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

async function capture(runner: ProcessRunner, command: string[], cwd: string): Promise<string> {
  let output = "";
  await runner(command, {
    cwd,
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
): Promise<Arm64BuilderReport> {
  let info: string;
  try {
    info = await capture(runner, [executable, "info", "--format", "{{json .}}"], cwd);
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
      const output = await capture(runner, [executable, "buildx", "inspect"], cwd);
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
  if (platforms.includes("linux/arm64") || platforms.includes("linux/arm64/v8")) return report;

  try {
    await probeArm64Execution(runner, cwd, executable);
    return report;
  } catch (error) {
    const found = [
      daemon ? `daemon ${daemon.os}/${daemon.arch}` : "daemon architecture unknown",
      buildx
        ? `buildx builder '${buildx.name ?? "unknown"}' (driver ${buildx.driver ?? "unknown"}) ` +
          "does not list linux/arm64"
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
 * A warning when the active Docker buildx builder's driver is not `docker`: images
 * it builds may not be loaded into the local image store, so CDK's push can fail.
 */
export function buildxDriverWarning(report: Arm64BuilderReport): string | undefined {
  const driver = report.buildx?.driver;
  if (!driver || driver === "docker") return undefined;
  const name = report.buildx?.name ?? "the active builder";
  return (
    `The active buildx builder '${name}' uses the ${driver} driver, so images it builds may not ` +
    "be loaded into the local Docker image store and the CDK push can fail. " +
    "Run 'docker buildx use default' to switch to the docker driver."
  );
}
