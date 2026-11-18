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
  BOX_RELEASE,
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
    "release.json": JSON.stringify({ box_version: VERSION }),
  };
  const box = await tarball(`box-v${VERSION}-aarch64-unknown-linux-gnu.tar.gz`, files);
  const ffi = await tarball("box-ffi-python3.14-aarch64-unknown-linux-gnu.tar.gz", {
    "libffi.so.8": "ffi",
  });
  const release: BoxRelease = {
    repo: "owner/box-releases",
    version: VERSION,
    target: "aarch64-unknown-linux-gnu",
    box: { asset: `box-v${VERSION}-aarch64-unknown-linux-gnu.tar.gz`, sha256: box.sha256 },
    ffi: {
      asset: "box-ffi-python3.14-aarch64-unknown-linux-gnu.tar.gz",
      sha256: ffi.sha256,
      runtimeVersion: "PYTHON_3_14",
    },
  };
  const assets: Record<string, string> = {
    [release.box.asset]: box.archive,
    [release.ffi.asset]: ffi.archive,
  };
  const commands: string[][] = [];
  // curl writes the asset its URL names to -o; tar runs for real.
  const runner: ProcessRunner = async (command, options) => {
    commands.push(command);
    if (command[0] !== "curl") return runProcess(command, options);
    const url = command.at(-1)!;
    const output = command[command.indexOf("-o") + 1]!;
    await writeFile(output, await readFile(assets[url.slice(url.lastIndexOf("/") + 1)]!));
  };
  return { release, runner, commands };
}

describe("resolveBoxLinuxBuild from the box release", () => {
  test("downloads both assets from the public release, checks them, and installs them under ~/.agentcore/box", async () => {
    const home = await temp("box-home-");
    const { release, runner, commands } = await fakeRelease();

    const build = await resolveBoxLinuxBuild({}, { runner, home, release });

    const root = join(home, ".agentcore", "box", `${VERSION}-aarch64-unknown-linux-gnu`);
    expect(build.binaries).toBe(root);
    expect(build.resources).toBe(join(root, "resources"));
    expect(build.ffi).toEqual({ PYTHON_3_14: join(root, "ffi", "PYTHON_3_14") });
    for (const binary of BINARIES) {
      expect((await stat(join(root, binary))).mode & 0o777).toBe(0o755);
    }
    expect(await readFile(join(root, "ffi", "PYTHON_3_14", "libffi.so.8"), "utf8")).toBe("ffi");
    expect(commands.filter((command) => command[0] === "curl")).toEqual(
      [release.box.asset, release.ffi.asset].map((asset) => [
        "curl",
        "-fsSL",
        "--retry",
        "3",
        "-o",
        expect.stringContaining(asset) as unknown as string,
        `https://github.com/owner/box-releases/releases/download/v${VERSION}/${asset}`,
      ]),
    );
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
    const pinned = { ...release, box: { ...release.box, sha256: "0".repeat(64) } };

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
      /has no release\.json for box 9\.9\.9-linux-preview\.1/,
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
  /** A runner whose curl serves SHA256SUMS.txt with `text`, and records each URL. */
  function sumsServer(text: string) {
    const urls: string[] = [];
    const runner: ProcessRunner = async (command) => {
      urls.push(command.at(-1)!);
      await writeFile(command[command.indexOf("-o") + 1]!, text);
    };
    return { runner, urls };
  }

  test("is the pinned release, with no download, for no version or a pinned one", async () => {
    const { runner, urls } = sumsServer("");

    expect(await boxReleaseFor(undefined, {}, { runner })).toBe(BOX_RELEASE);
    expect(await boxReleaseFor(BOX_RELEASE.version, {}, { runner })).toBe(BOX_RELEASE);
    expect(urls).toEqual([]);
  });

  test("takes another version's checksums from its release's SHA256SUMS.txt", async () => {
    const home = await temp("box-home-");
    const linux = "a".repeat(64);
    const ffi = "b".repeat(64);
    const { runner, urls } = sumsServer(
      `${linux}  box-v2.0.0-aarch64-unknown-linux-gnu.tar.gz\n` +
        `${ffi}  ${BOX_RELEASE.ffi.asset}\n`,
    );

    const release = await boxReleaseFor("2.0.0", {}, { runner, home });

    expect(urls).toEqual([
      `https://github.com/${BOX_RELEASE.repo}/releases/download/v2.0.0/SHA256SUMS.txt`,
    ]);
    expect(release.version).toBe("2.0.0");
    expect(release.box).toEqual({
      asset: "box-v2.0.0-aarch64-unknown-linux-gnu.tar.gz",
      sha256: linux,
    });
    expect(release.ffi.sha256).toBe(ffi);
  });

  test("refuses a version whose release lists no Linux box", async () => {
    const home = await temp("box-home-");
    const { runner } = sumsServer(`${"b".repeat(64)}  ${BOX_RELEASE.ffi.asset}\n`);

    await expect(boxReleaseFor("2.0.0", {}, { runner, home })).rejects.toThrow(
      /box 2\.0\.0, which agentcore\.json names under box\.version, has no box-v2\.0\.0-aarch64-unknown-linux-gnu\.tar\.gz/,
    );
  });
});
