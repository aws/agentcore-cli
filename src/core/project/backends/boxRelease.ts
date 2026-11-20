import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { InvalidEnvironmentError } from "../../../errors/errors";
import { type ProcessRunner, runProcess } from "../../../io/exec";
import { isFile } from "../runtimeBuild";
import pinned from "./boxRelease.json";

/** One archive of a GitHub release, and its pinned SHA-256. */
const AssetSchema = z.object({
  asset: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const TargetAssetSchema = AssetSchema.extend({ target: z.string().min(1) });

/**
 * A box release: the Linux arm64 build that ships to AgentCore Runtime. Its archive holds box,
 * its helpers, its packs and release.json.
 */
const BoxReleaseSchema = z.object({
  repo: z.string().min(1),
  version: z.string().min(1),
  linux: TargetAssetSchema,
});

export type BoxRelease = z.infer<typeof BoxReleaseSchema>;

/**
 * The release this CLI pins, from boxRelease.json. The checksums are pinned there, not read
 * from a release's SHA256SUMS.txt, so a changed asset fails instead of shipping.
 * `scripts/bump-box-release.ts` rewrites the file.
 */
const PINNED = z.object({ box: BoxReleaseSchema }).parse(pinned);
export const BOX_RELEASE: BoxRelease = PINNED.box;

/**
 * The first box release that reads the profiles that the CLI writes: their `@box/<name>` packs, and
 * the `key` of an input of the `@box/agentcore` pack.
 */
export const BOX_MINIMUM_VERSION = "0.1.11-linux-preview.7";

/** The GitHub release page of the pinned box, with a build for each machine it supports. */
export const BOX_RELEASE_PAGE = `https://github.com/${BOX_RELEASE.repo}/releases/tag/v${BOX_RELEASE.version}`;

/** Where a release's asset downloads from: the public GitHub release, no token needed. */
export function boxReleaseAssetUrl(
  release: Pick<BoxRelease, "repo" | "version">,
  asset: string,
): string {
  return `https://github.com/${release.repo}/releases/download/v${release.version}/${asset}`;
}

/** box and the two helper programs it runs, which must sit beside it. */
export const BOX_BINARIES = [
  "box",
  "strands-box-sock-alias",
  "strands-box-contain-trampoline",
] as const;

/**
 * How to install the `box` that `agentcore dev` runs a CodeZip box agent with, which create and
 * dev ask for when it is not on PATH. The release has a build for each machine it supports.
 */
export const BOX_INSTALL_HINT =
  `Install box: download the build for your machine from ${BOX_RELEASE_PAGE}, unpack it into ` +
  "a folder (tar -xzf <archive> -C <folder>), and add that folder to your PATH.";

/** A Linux arm64 box for AgentCore Runtime. */
export type BoxLinuxBuild = {
  /** The folder that holds box and its helpers. */
  binaries: string;
  /** box's packs. */
  resources: string;
};

/** What is about to download, which happens once per version. */
export type BoxDownload = { name: string; version: string; url: string };
export type OnBoxDownload = (download: BoxDownload) => void;

/** The line that says something of box is downloading, and for what. */
export function boxDownloadMessage(download: BoxDownload, forWhat: string): string {
  return (
    `downloading ${download.name} ${download.version} for ${forWhat} from ${download.url} ` +
    "(once; later runs reuse ~/.agentcore/)"
  );
}

export type ResolveBoxLinuxBuildOptions = {
  /** Runs curl and tar; tests inject one. */
  runner?: ProcessRunner;
  onDownload?: OnBoxDownload;
  /** The home folder the caches are in, `~/.agentcore/`. */
  home?: string;
  /** The box release to install; BOX_RELEASE by default. */
  release?: BoxRelease;
};

/** The cache of box builds, by version and target. */
function boxCache(home: string): string {
  return join(home, ".agentcore", "box");
}

/** Where a box build is cached. */
export function boxCachePath(home: string, version: string, target: string): string {
  return join(boxCache(home), `${version}-${target}`);
}

/**
 * The Linux box for AgentCore Runtime from `release`. It downloads once with curl from its public
 * URL, after its checksum matches, into `~/.agentcore/box/<version>-<target>/`. Later runs reuse it.
 */
export async function resolveBoxLinuxBuild(
  env: NodeJS.ProcessEnv,
  options: ResolveBoxLinuxBuildOptions = {},
): Promise<BoxLinuxBuild> {
  const release = options.release ?? BOX_RELEASE;
  // HOME from the environment the CLI was given, so the caches follow it.
  const home = options.home ?? env.HOME ?? homedir();
  const runner = options.runner ?? runProcess;
  const root = await installBox(release, release.linux, env, runner, home, options.onDownload, {
    forWhat: "AgentCore Runtime",
  });
  return { binaries: root, resources: join(root, "resources") };
}

/** Whether `root` holds box `version`: release.json, box, its helpers, and its packs. */
function installedBox(version: string, root: string): boolean {
  const metadata = join(root, "release.json");
  if (!isFile(metadata)) return false;
  try {
    const installed = JSON.parse(readFileSync(metadata, "utf8")) as { box_version?: unknown };
    if (installed.box_version !== version) return false;
  } catch {
    return false;
  }
  return (
    BOX_BINARIES.every((binary) => isFile(join(root, binary))) &&
    // Every box release ships resources/config.toml; the packs folder beside it has moved before.
    isFile(join(root, "resources", "config.toml"))
  );
}

/** Downloads `asset` of `release` into a new folder under `cache`, checks it, and returns it. */
async function downloadChecked(
  release: Pick<BoxRelease, "repo" | "version">,
  { asset, sha256 }: { asset: string; sha256: string },
  cache: string,
  env: NodeJS.ProcessEnv,
  runner: ProcessRunner,
  failure: (url: string) => string,
): Promise<{ work: string; archive: string }> {
  mkdirSync(cache, { recursive: true });
  const work = mkdtempSync(join(cache, ".download-"));
  try {
    await download(release, asset, work, env, runner, failure);
    const archive = join(work, asset);
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    if (digest !== sha256) {
      throw new InvalidEnvironmentError(
        `${asset} from github.com/${release.repo} has SHA-256 ${digest}, not the pinned ` +
          `${sha256}. Nothing was installed.`,
      );
    }
    return { work, archive };
  } catch (error) {
    rmSync(work, { recursive: true, force: true });
    throw error;
  }
}

/** Installs one box build of `release` into its cache folder, once, and returns the folder. */
async function installBox(
  release: BoxRelease,
  build: { target: string; asset: string; sha256: string },
  env: NodeJS.ProcessEnv,
  runner: ProcessRunner,
  home: string,
  onDownload: OnBoxDownload | undefined,
  { forWhat }: { forWhat: string },
): Promise<string> {
  const root = boxCachePath(home, release.version, build.target);
  if (installedBox(release.version, root)) return root;

  const url = boxReleaseAssetUrl(release, build.asset);
  onDownload?.({ name: "box", version: release.version, url });
  const { work, archive } = await downloadChecked(
    release,
    build,
    boxCache(home),
    env,
    runner,
    (failed) =>
      `this runs box ${release.version} for ${forWhat}, downloaded from ${failed}, which ` +
      "failed. Check your network, then retry.",
  );
  try {
    const payload = join(work, "payload");
    mkdirSync(payload);
    await runner(["tar", "-xzf", archive, "-C", payload], { cwd: work, env });
    for (const binary of BOX_BINARIES) {
      if (!isFile(join(payload, binary))) {
        throw new InvalidEnvironmentError(`${build.asset} has no ${binary}.`);
      }
      chmodSync(join(payload, binary), 0o755);
    }
    if (!installedBox(release.version, payload)) {
      throw new InvalidEnvironmentError(
        `${build.asset} has no release.json for box ${release.version}, or no box packs.`,
      );
    }
    rmSync(root, { recursive: true, force: true });
    renameSync(payload, root);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return root;
}

async function download(
  release: Pick<BoxRelease, "repo" | "version">,
  asset: string,
  into: string,
  env: NodeJS.ProcessEnv,
  runner: ProcessRunner,
  failure: (url: string) => string,
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

/**
 * The box release that `version`, a runtime's `box.version`, names. It must be the pinned one,
 * BOX_RELEASE, whose checksums `boxRelease.json` pins: another box is untested with this CLI (box
 * 0.1.11-linux-preview.6, for one, refuses the `@box/` packs the CLI writes), and build cannot
 * see that, since it checks the profile with the box on PATH. No version means BOX_RELEASE.
 */
export async function boxReleaseFor(version: string | undefined): Promise<BoxRelease> {
  if (version === undefined || version === BOX_RELEASE.version) return BOX_RELEASE;
  throw new InvalidEnvironmentError(
    `agentcore.json names box ${version} under box.version, but this CLI ships box ` +
      `${BOX_RELEASE.version}, the one box it pins. Set box.version to ${BOX_RELEASE.version}, ` +
      "then retry.",
  );
}
