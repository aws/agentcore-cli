import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidEnvironmentError } from "../../../errors/errors";
import { type ProcessRunner, runProcess } from "../../../io/exec";
import {
  BOX_MINIMUM_VERSION,
  BOX_RELEASE,
  BOX_RELEASE_PAGE,
  type BoxRelease,
  boxReleaseFor,
  resolveBoxLinuxBuild,
} from "./boxRelease";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temp(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

const BINARIES = ["box", "strands-box-sock-alias", "strands-box-contain-trampoline"];
const VERSION = "9.9.9-linux-preview.1";

/** A tarball of `files` (relative path to content), and its SHA-256. */
async function tarball(name: string, files: Record<string, string>) {
  const stage = await temp("box-stage-");
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(stage, path, ".."), { recursive: true });
    await writeFile(join(stage, path), content);
  }
  const archive = join(await temp("box-asset-"), name);
  execFileSync("tar", ["-czf", archive, "-C", stage, "."]);
  const sha256 = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  return { archive, sha256 };
}

/** A release in the layout of BOX_RELEASE, with archives the fake gh serves. */
async function fakeRelease(boxFiles?: Record<string, string>) {
  const files = boxFiles ?? {
    ...Object.fromEntries(BINARIES.map((binary) => [binary, `#!${binary}\n`])),
    "resources/shared/base/pack.toml": "[pack]\n",
    "resources/config.toml": "",
    "release.json": JSON.stringify({ box_version: VERSION }),
  };
  const box = await tarball(`box-v${VERSION}-aarch64-unknown-linux-gnu.tar.gz`, files);
  const release: BoxRelease = {
    repo: "owner/box-releases",
    version: VERSION,
    linux: {
      target: "aarch64-unknown-linux-gnu",
      asset: `box-v${VERSION}-aarch64-unknown-linux-gnu.tar.gz`,
      sha256: box.sha256,
    },
  };
  const assets: Record<string, string> = { [release.linux.asset]: box.archive };
  const commands: string[][] = [];
  // curl writes the asset its URL names to -o; tar runs for real. The tests pass an empty
  // environment, which on Windows leaves no PATH to find tar by, so tar gets this process's.
  const runner: ProcessRunner = async (command, options) => {
    commands.push(command);
    if (command[0] !== "curl") {
      return runProcess(command, { ...options, env: { ...process.env, ...options?.env } });
    }
    const url = command.at(-1)!;
    const output = command[command.indexOf("-o") + 1]!;
    await writeFile(output, await readFile(assets[url.slice(url.lastIndexOf("/") + 1)]!));
  };
  return { release, runner, commands };
}

describe("resolveBoxLinuxBuild from the box release", () => {
  test("downloads box, checks it, and caches it", async () => {
    const home = await temp("box-home-");
    const { release, runner, commands } = await fakeRelease();
    const downloads: string[] = [];

    const build = await resolveBoxLinuxBuild(
      {},
      { runner, home, release, onDownload: ({ name }) => downloads.push(name) },
    );

    const root = join(home, ".agentcore", "box", `${VERSION}-aarch64-unknown-linux-gnu`);
    expect(build.binaries).toBe(root);
    expect(build.resources).toBe(join(root, "resources"));
    expect(build).toEqual({ binaries: root, resources: join(root, "resources") });
    // Windows has no mode bits.
    if (process.platform !== "win32") {
      for (const binary of BINARIES) {
        expect((await stat(join(root, binary))).mode & 0o777).toBe(0o755);
      }
    }
    expect(downloads).toEqual(["box"]);
    expect(
      commands.filter((command) => command[0] === "curl").map((command) => command.at(-1)),
    ).toEqual([
      `https://github.com/owner/box-releases/releases/download/v${VERSION}/${release.linux.asset}`,
    ]);
  });

  test("reuses an installed release without downloading again", async () => {
    const home = await temp("box-home-");
    const { release, runner, commands } = await fakeRelease();
    await resolveBoxLinuxBuild({}, { runner, home, release });
    commands.length = 0;

    await resolveBoxLinuxBuild({}, { runner, home, release });

    expect(commands).toEqual([]);
  });

  test("installs nothing when an asset's checksum is not the pinned one", async () => {
    const home = await temp("box-home-");
    const { release, runner } = await fakeRelease();
    const pinned = { ...release, linux: { ...release.linux, sha256: "0".repeat(64) } };

    const result = resolveBoxLinuxBuild({}, { runner, home, release: pinned });

    await expect(result).rejects.toThrow(InvalidEnvironmentError);
    await expect(result).rejects.toThrow(/not the pinned 0{64}\. Nothing was installed/);
    expect(
      existsSync(join(home, ".agentcore", "box", `${VERSION}-aarch64-unknown-linux-gnu`)),
    ).toBe(false);
  });

  test("refuses an archive with no release.json for the pinned version", async () => {
    const home = await temp("box-home-");
    const { release, runner } = await fakeRelease(
      Object.fromEntries(BINARIES.map((binary) => [binary, "x"])),
    );

    await expect(resolveBoxLinuxBuild({}, { runner, home, release })).rejects.toThrow(
      /has no release\.json for box 9\.9\.9-linux-preview\.1, or no box packs/,
    );
  });

  test("names the URL when the download fails", async () => {
    const home = await temp("box-home-");
    const { release } = await fakeRelease();
    const runner: ProcessRunner = async () => {
      throw new Error("HTTP 404: Not Found");
    };

    const result = resolveBoxLinuxBuild({}, { runner, home, release });

    await expect(result).rejects.toThrow(
      /downloaded from https:\/\/github\.com\/owner\/box-releases\/releases\/download\/v9\.9\.9-linux-preview\.1\/box-v/,
    );
    await expect(result).rejects.toThrow(/HTTP 404: Not Found/);
  });
});

describe("boxReleaseFor a runtime's box.version", () => {
  test("is the pinned release for no version or the pinned one", async () => {
    expect(await boxReleaseFor(undefined)).toBe(BOX_RELEASE);
    expect(await boxReleaseFor(BOX_RELEASE.version)).toBe(BOX_RELEASE);
  });

  test.each(["0.1.11-linux-preview.6", "2.0.0"])(
    "refuses %s, a box this CLI does not pin, and says to set the pinned one",
    async (version) => {
      await expect(boxReleaseFor(version)).rejects.toThrow(
        new InvalidEnvironmentError(
          `agentcore.json names box ${version} under box.version, but this CLI ships box ` +
            `${BOX_RELEASE.version}, the one box it pins. Set box.version to ` +
            `${BOX_RELEASE.version}, then retry.`,
        ),
      );
    },
  );
});

describe("the pinned releases", () => {
  test("pins one box, with the asset of its own version and a SHA-256", () => {
    expect(BOX_MINIMUM_VERSION).toBe("0.1.11-linux-preview.7");
    expect(BOX_RELEASE.linux.asset).toBe(
      `box-v${BOX_RELEASE.version}-aarch64-unknown-linux-gnu.tar.gz`,
    );
    expect(BOX_RELEASE.linux.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(BOX_RELEASE_PAGE).toBe(
      `https://github.com/mquang-amazon/box-releases/releases/tag/v${BOX_RELEASE.version}`,
    );
  });
});
