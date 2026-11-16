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
  /**
   * The builds `agentcore dev` runs a CodeZip agent with on this machine, by `<platform>-<arch>`
   * of Node (`darwin-arm64`). Each archive holds box, its helpers, its packs and release.json.
   */
  dev: Partial<Record<string, { target: string; asset: string; sha256: string }>>;
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
  dev: {
    "darwin-arm64": {
      target: "aarch64-apple-darwin",
      asset: "box-v0.1.11-linux-preview.2-aarch64-apple-darwin.tar.gz",
      sha256: "0d6d9ef1ab2e41068fd421d20383eb13b06797ff9962bf6e42336bc998c350ed",
    },
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

/** Told the URL of a box archive just before it downloads, which happens once per version. */
export type OnBoxDownload = (url: string) => void;

/** The line that says box is downloading, for `version` and the machine it runs on. */
export function boxDownloadMessage(version: string, url: string, forWhat: string): string {
  return (
    `downloading box ${version} for ${forWhat} from ${url} ` +
    "(once; later runs reuse ~/.agentcore/box/)"
  );
}

export type ResolveBoxLinuxBuildOptions = {
  /** Runs curl and tar; tests inject one. */
  runner?: ProcessRunner;
  onDownload?: OnBoxDownload;
  /** The home folder the release cache is in, `~/.agentcore/box/`. */
  home?: string;
  /** The release to install; BOX_RELEASE by default. */
  release?: BoxRelease;
};

/**
 * The Linux box for AgentCore Runtime, from `release` (BOX_RELEASE by default). The release
 * downloads once with curl from its public URL, into `~/.agentcore/box/<version>-<target>/`,
 * after its checksums match; later runs reuse it.
 */
export async function resolveBoxLinuxBuild(
  env: NodeJS.ProcessEnv,
  options: ResolveBoxLinuxBuildOptions = {},
): Promise<BoxLinuxBuild> {
  const release = options.release ?? BOX_RELEASE;
  // HOME from the environment the CLI was given, so the cache follows it.
  const home = options.home ?? env.HOME ?? homedir();
  return releaseBuild(release, env, options.runner ?? runProcess, home, options.onDownload);
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
  onDownload: OnBoxDownload | undefined,
): Promise<BoxLinuxBuild> {
  const cache = join(home, ".agentcore", "box");
  const root = join(cache, `${release.version}-${release.target}`);
  const installed = installedRelease(release, root);
  if (installed) return installed;

  mkdirSync(cache, { recursive: true });
  const work = mkdtempSync(join(cache, ".download-"));
  try {
    onDownload?.(boxReleaseAssetUrl(release, release.box.asset));
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
  failure: (url: string) => string = (url) =>
    `a runtime runs its agent in a box, so this ships box ${release.version} to AgentCore ` +
    `Runtime, downloaded from ${url}, which failed. Check your network, then retry.`,
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
      `${failure(url)}\n\n${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export type ResolveBoxDevBinaryOptions = {
  /** Runs curl and tar; tests inject one. */
  runner?: ProcessRunner;
  /** The home folder the release cache is in, `~/.agentcore/box/`. */
  home?: string;
  /** The release to install; BOX_RELEASE by default. */
  release?: BoxRelease;
  onDownload?: OnBoxDownload;
  /** Node's `process.platform` and `process.arch`, which pick the build; tests pin them. */
  platform?: string;
  arch?: string;
};

/**
 * The `box` that `agentcore dev` runs a CodeZip agent with: the release's build for this machine,
 * which downloads once with curl into `~/.agentcore/box/<version>-<target>/` after its pinned
 * checksum matches, with its packs beside it; later runs reuse it. `undefined` when the release
 * has no build for this machine, so dev runs the `box` on PATH.
 */
export async function resolveBoxDevBinary(
  env: NodeJS.ProcessEnv,
  options: ResolveBoxDevBinaryOptions = {},
): Promise<string | undefined> {
  const release = options.release ?? BOX_RELEASE;
  const machine = `${options.platform ?? process.platform}-${options.arch ?? process.arch}`;
  const build = release.dev[machine];
  if (!build) return undefined;
  const home = options.home ?? env.HOME ?? homedir();
  const cache = join(home, ".agentcore", "box");
  const root = join(cache, `${release.version}-${build.target}`);
  if (installedDevBuild(release, root)) return join(root, "box");

  const runner = options.runner ?? runProcess;
  mkdirSync(cache, { recursive: true });
  const work = mkdtempSync(join(cache, ".download-"));
  try {
    options.onDownload?.(boxReleaseAssetUrl(release, build.asset));
    await download(
      release,
      build.asset,
      work,
      env,
      runner,
      (url) =>
        `agentcore dev runs the CodeZip agent in box ${release.version}, downloaded from ` +
        `${url}, which failed. Check your network, then retry.`,
    );
    const archive = join(work, build.asset);
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    if (digest !== build.sha256) {
      throw new InvalidEnvironmentError(
        `${build.asset} from github.com/${release.repo} has SHA-256 ${digest}, not the pinned ` +
          `${build.sha256}. Nothing was installed.`,
      );
    }
    const payload = join(work, "payload");
    mkdirSync(payload);
    await runner(["tar", "-xzf", archive, "-C", payload], { cwd: work, env });
    for (const binary of BOX_BINARIES) {
      if (!isFile(join(payload, binary))) {
        throw new InvalidEnvironmentError(`${build.asset} has no ${binary}.`);
      }
      chmodSync(join(payload, binary), 0o755);
    }
    rmSync(root, { recursive: true, force: true });
    renameSync(payload, root);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (!installedDevBuild(release, root)) {
    throw new InvalidEnvironmentError(
      `${build.asset} has no release.json for box ${release.version}, or no box packs.`,
    );
  }
  return join(root, "box");
}

/** Whether `root` holds the pinned version's dev build: release.json, box, and its packs. */
function installedDevBuild(release: BoxRelease, root: string): boolean {
  if (!installedRelease(release, root)) return false;
  return (
    BOX_BINARIES.every((binary) => isFile(join(root, binary))) &&
    existsSync(join(root, "resources", "shared"))
  );
}

/** The box releases this CLI pins checksums for, by version. */
const PINNED_BOX_RELEASES: Readonly<Record<string, BoxRelease>> = {
  [BOX_RELEASE.version]: BOX_RELEASE,
};

/**
 * The box release of `version`, which a runtime's `box.version` names: one this CLI pins, else
 * one in BOX_RELEASE's repository, in its layout, whose checksums come from the release's own
 * SHA256SUMS.txt. No version means BOX_RELEASE.
 */
export async function boxReleaseFor(
  version: string | undefined,
  env: NodeJS.ProcessEnv,
  options: { runner?: ProcessRunner; home?: string } = {},
): Promise<BoxRelease> {
  if (version === undefined) return BOX_RELEASE;
  const pinned = PINNED_BOX_RELEASES[version];
  if (pinned) return pinned;
  const assets = {
    box: `box-v${version}-${BOX_RELEASE.target}.tar.gz`,
    ffi: BOX_RELEASE.ffi.asset,
    mac: `box-v${version}-aarch64-apple-darwin.tar.gz`,
  };
  const release: BoxRelease = { ...BOX_RELEASE, version, dev: {} };
  const sums = await releaseChecksums(release, env, options.runner ?? runProcess, options.home);
  const sha = (asset: string) => sums.get(asset);
  const boxSha = sha(assets.box);
  const ffiSha = sha(assets.ffi);
  if (!boxSha || !ffiSha) {
    throw new InvalidEnvironmentError(
      `box ${version}, which agentcore.json names under box.version, has no ` +
        `${boxSha ? assets.ffi : assets.box} in the SHA256SUMS.txt of its release at ` +
        `github.com/${release.repo}. Name a box version that release has, or remove box.version ` +
        `to use box ${BOX_RELEASE.version}.`,
    );
  }
  const macSha = sha(assets.mac);
  return {
    ...release,
    box: { asset: assets.box, sha256: boxSha },
    ffi: { ...BOX_RELEASE.ffi, sha256: ffiSha },
    dev: macSha
      ? { "darwin-arm64": { target: "aarch64-apple-darwin", asset: assets.mac, sha256: macSha } }
      : {},
  };
}

/** The SHA-256 of each asset of `release`, from the SHA256SUMS.txt it publishes. */
async function releaseChecksums(
  release: BoxRelease,
  env: NodeJS.ProcessEnv,
  runner: ProcessRunner,
  home: string | undefined,
): Promise<Map<string, string>> {
  const cache = join(home ?? env.HOME ?? homedir(), ".agentcore", "box");
  mkdirSync(cache, { recursive: true });
  const work = mkdtempSync(join(cache, ".download-"));
  try {
    await download(
      release,
      "SHA256SUMS.txt",
      work,
      env,
      runner,
      (url) =>
        `agentcore.json names box ${release.version} under box.version, whose checksums ` +
        `download from ${url}, which failed. Check the version and your network, then retry.`,
    );
    const sums = new Map<string, string>();
    for (const line of readFileSync(join(work, "SHA256SUMS.txt"), "utf8").split("\n")) {
      const match = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
      if (match) sums.set(match[2]!, match[1]!);
    }
    return sums;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
