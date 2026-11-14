import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { InvalidEnvironmentError } from "../../../errors/errors";
import { type ProcessRunner, runProcess } from "../../../io/exec";
import { isFile } from "../runtimeBuild";

/**
 * The box release that dev and deploy ship to AgentCore Runtime: the Linux arm64 build, from a
 * GitHub release in the layout `install.sh` takes. The release also carries the Python ffi shim
 * as its own asset, since the box archive may hold only box, its helpers, its packs and
 * release.json. The checksums are pinned here, not read from the release's SHA256SUMS.txt, so a
 * changed asset fails instead of shipping.
 */
export type BoxRelease = {
  repo: string;
  version: string;
  target: string;
  box: { asset: string; sha256: string };
  ffi: { asset: string; sha256: string; runtimeVersion: string };
};

export const BOX_RELEASE: BoxRelease = {
  repo: "mquang-amazon/box-releases",
  version: "0.1.11-linux-preview.2",
  target: "aarch64-unknown-linux-gnu",
  box: {
    asset: "box-v0.1.11-linux-preview.2-aarch64-unknown-linux-gnu.tar.gz",
    sha256: "31605fd1c6e8d2d31e0222e3612ea978dc65c0c369e8a97e964bf848b460122c",
  },
  ffi: {
    asset: "box-ffi-python3.14-aarch64-unknown-linux-gnu.tar.gz",
    sha256: "1266d484cbdbfa9df53a0aa29efbc0a1063e0ace9945bca5489b5f828f68b54e",
    runtimeVersion: "PYTHON_3_14",
  },
};

/** Where a release's asset downloads from: the public GitHub release, no token needed. */
export function boxReleaseAssetUrl(release: BoxRelease, asset: string): string {
  return `https://github.com/${release.repo}/releases/download/v${release.version}/${asset}`;
}

/** box and the two helper programs it runs, which must sit beside it. */
export const BOX_BINARIES = [
  "box",
  "strands-box-sock-alias",
  "strands-box-contain-trampoline",
] as const;

/** A Linux arm64 box for AgentCore Runtime, and the Python ffi shims, by runtimeVersion. */
export type BoxLinuxBuild = {
  /** The folder that holds box and its helpers. */
  binaries: string;
  /** box's packs. */
  resources: string;
  /** The `_ctypes` and libffi that Box Core's W^X filter allows, for each Python it is built for. */
  ffi: Partial<Record<string, string>>;
};

export type ResolveBoxLinuxBuildOptions = {
  /** Runs curl and tar; tests inject one. */
  runner?: ProcessRunner;
  /** The home folder the release cache is in, `~/.agentcore/box/`. */
  home?: string;
  /** The release to install; BOX_RELEASE by default. */
  release?: BoxRelease;
};

/** The local build in a staging-boxy checkout that AGENTCORE_BOX_SOURCE names. */
const SOURCE_BUILD = join("target-al2023", "release");
const SOURCE_FFI = join("target-al2023", "ffi");

/**
 * Where box for AgentCore Runtime comes from: the staging-boxy checkout AGENTCORE_BOX_SOURCE
 * names, for a local build, or else BOX_RELEASE. The release downloads once with curl from its public URL, into
 * `~/.agentcore/box/<version>-<target>/`, after its pinned checksums match; later runs reuse it.
 * Only CodeZip runtimes use it: a container image installs box itself, from its Dockerfile.
 */
export async function resolveBoxLinuxBuild(
  env: NodeJS.ProcessEnv,
  options: ResolveBoxLinuxBuildOptions = {},
): Promise<BoxLinuxBuild> {
  const source = env.AGENTCORE_BOX_SOURCE;
  const release = options.release ?? BOX_RELEASE;
  if (source) return sourceBuild(source, release);
  // HOME from the environment the CLI was given, so the cache follows it.
  const home = options.home ?? env.HOME ?? homedir();
  return releaseBuild(release, env, options.runner ?? runProcess, home);
}

function sourceBuild(source: string, release: BoxRelease): BoxLinuxBuild {
  const binaries = join(source, SOURCE_BUILD);
  for (const binary of BOX_BINARIES) {
    if (!isFile(join(binaries, binary))) {
      throw new InvalidEnvironmentError(
        `AGENTCORE_BOX_SOURCE has no ${join(binaries, binary)}. Build box on Amazon Linux 2023 ` +
          `into ${SOURCE_BUILD} there, or unset AGENTCORE_BOX_SOURCE to use box ` +
          `${release.version}.`,
      );
    }
  }
  const resources = join(source, "resources");
  if (!existsSync(resources)) {
    throw new InvalidEnvironmentError(`AGENTCORE_BOX_SOURCE has no box packs at ${resources}.`);
  }
  const ffi = join(source, SOURCE_FFI);
  return {
    binaries,
    resources,
    ffi: existsSync(ffi) ? { [release.ffi.runtimeVersion]: ffi } : {},
  };
}

/** The installed release: release.json names the pinned version. */
function installedRelease(release: BoxRelease, root: string): BoxLinuxBuild | undefined {
  const metadata = join(root, "release.json");
  if (!isFile(metadata)) return undefined;
  try {
    const installed = JSON.parse(readFileSync(metadata, "utf8")) as { box_version?: unknown };
    if (installed.box_version !== release.version) return undefined;
  } catch {
    return undefined;
  }
  return {
    binaries: root,
    resources: join(root, "resources"),
    ffi: { [release.ffi.runtimeVersion]: join(root, "ffi", release.ffi.runtimeVersion) },
  };
}

async function releaseBuild(
  release: BoxRelease,
  env: NodeJS.ProcessEnv,
  runner: ProcessRunner,
  home: string,
): Promise<BoxLinuxBuild> {
  const cache = join(home, ".agentcore", "box");
  const root = join(cache, `${release.version}-${release.target}`);
  const installed = installedRelease(release, root);
  if (installed) return installed;

  mkdirSync(cache, { recursive: true });
  const work = mkdtempSync(join(cache, ".download-"));
  try {
    for (const { asset } of [release.box, release.ffi]) {
      await download(release, asset, work, env, runner);
    }
    const payload = join(work, "payload");
    const ffi = join(payload, "ffi", release.ffi.runtimeVersion);
    mkdirSync(ffi, { recursive: true });
    for (const [{ asset, sha256 }, into] of [
      [release.box, payload],
      [release.ffi, ffi],
    ] as const) {
      const archive = join(work, asset);
      const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
      if (digest !== sha256) {
        throw new InvalidEnvironmentError(
          `${asset} from github.com/${release.repo} has SHA-256 ${digest}, not the pinned ` +
            `${sha256}. Nothing was installed.`,
        );
      }
      await runner(["tar", "-xzf", archive, "-C", into], { cwd: work, env });
    }
    for (const binary of BOX_BINARIES) {
      if (!isFile(join(payload, binary))) {
        throw new InvalidEnvironmentError(`${release.box.asset} has no ${binary}.`);
      }
      chmodSync(join(payload, binary), 0o755);
    }
    rmSync(root, { recursive: true, force: true });
    renameSync(payload, root);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const build = installedRelease(release, root);
  if (!build) {
    throw new InvalidEnvironmentError(
      `${release.box.asset} has no release.json for box ${release.version}.`,
    );
  }
  return build;
}

async function download(
  release: BoxRelease,
  asset: string,
  into: string,
  env: NodeJS.ProcessEnv,
  runner: ProcessRunner,
): Promise<void> {
  const url = boxReleaseAssetUrl(release, asset);
  try {
    await runner(["curl", "-fsSL", "--retry", "3", "-o", join(into, asset), url], {
      cwd: into,
      env,
    });
    if (!isFile(join(into, asset))) throw new Error(`curl downloaded no ${asset}`);
  } catch (error) {
    throw new InvalidEnvironmentError(
      `a runtime runs its agent in a box, so this ships box ${release.version} to AgentCore ` +
        `Runtime, downloaded from ${url}, which failed. Check your network, or set ` +
        `AGENTCORE_BOX_SOURCE to a staging-boxy checkout with a Linux build.\n\n` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}
