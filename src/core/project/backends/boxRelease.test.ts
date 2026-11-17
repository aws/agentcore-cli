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
  FFI_RELEASE,
  type BoxRelease,
  type FfiRelease,
  boxReleaseFor,
  resolveBoxDevBinary,
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
const FFI_VERSION = "3.0.0";

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
  const mac = await tarball(`box-v${VERSION}-aarch64-apple-darwin.tar.gz`, files);
  const ffi = await tarball("box-ffi-python3.14-aarch64-unknown-linux-gnu.tar.gz", {
    "libffi.so.8": "ffi",
  });
  const release: BoxRelease = {
    repo: "owner/box-releases",
    version: VERSION,
    linux: {
      target: "aarch64-unknown-linux-gnu",
      asset: `box-v${VERSION}-aarch64-unknown-linux-gnu.tar.gz`,
      sha256: box.sha256,
    },
    dev: {
      "darwin-arm64": {
        target: "aarch64-apple-darwin",
        asset: `box-v${VERSION}-aarch64-apple-darwin.tar.gz`,
        sha256: mac.sha256,
      },
    },
  };
  // The ffi shim ships from its own repository and version.
  const ffiRelease: FfiRelease = {
    repo: "other/ffi-releases",
    version: FFI_VERSION,
    pythons: {
      PYTHON_3_14: {
        asset: "box-ffi-python3.14-aarch64-unknown-linux-gnu.tar.gz",
        sha256: ffi.sha256,
      },
    },
  };
  const assets: Record<string, string> = {
    [release.linux.asset]: box.archive,
    [ffiRelease.pythons.PYTHON_3_14!.asset]: ffi.archive,
    [`box-v${VERSION}-aarch64-apple-darwin.tar.gz`]: mac.archive,
  };
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
  return { release, ffi: ffiRelease, runner, commands };
}

describe("resolveBoxLinuxBuild from the box release", () => {
  test("downloads box and the ffi shim, each from its own release, checks them, and caches each on its own", async () => {
    const home = await temp("box-home-");
    const { release, ffi, runner, commands } = await fakeRelease();
    const downloads: string[] = [];

    const build = await resolveBoxLinuxBuild(
      {},
      { runner, home, release, ffi, onDownload: ({ name }) => downloads.push(name) },
    );

    const root = join(home, ".agentcore", "box", `${VERSION}-aarch64-unknown-linux-gnu`);
    const shim = join(home, ".agentcore", "box-ffi", FFI_VERSION, "PYTHON_3_14");
    expect(build.binaries).toBe(root);
    expect(build.resources).toBe(join(root, "resources"));
    expect(build.ffi).toEqual({ PYTHON_3_14: shim });
    // Windows has no mode bits.
    if (process.platform !== "win32") {
      for (const binary of BINARIES) {
        expect((await stat(join(root, binary))).mode & 0o777).toBe(0o755);
      }
    }
    expect(await readFile(join(shim, "libffi.so.8"), "utf8")).toBe("ffi");
    expect(downloads).toEqual(["box", "the box ffi shim for PYTHON_3_14"]);
    expect(
      commands.filter((command) => command[0] === "curl").map((command) => command.at(-1)),
    ).toEqual([
      `https://github.com/owner/box-releases/releases/download/v${VERSION}/${release.linux.asset}`,
      `https://github.com/other/ffi-releases/releases/download/v${FFI_VERSION}/box-ffi-python3.14-aarch64-unknown-linux-gnu.tar.gz`,
    ]);
  });

  test("downloads only the ffi shim when its pin changes and box is cached", async () => {
    const home = await temp("box-home-");
    const { release, ffi, runner, commands } = await fakeRelease();
    await resolveBoxLinuxBuild({}, { runner, home, release, ffi });
    commands.length = 0;
    // A shim pinned with another checksum is not the cached one, so it downloads again.
    const repinned = {
      ...ffi,
      pythons: { PYTHON_3_14: { ...ffi.pythons.PYTHON_3_14!, sha256: "0".repeat(64) } },
    };

    await expect(
      resolveBoxLinuxBuild({}, { runner, home, release, ffi: repinned }),
    ).rejects.toThrow(/not the pinned 0{64}/);

    expect(commands.filter((command) => command[0] === "curl")).toHaveLength(1);
    expect(commands[0]!.at(-1)).toContain("other/ffi-releases");
  });

  test("reuses an installed release without downloading again", async () => {
    const home = await temp("box-home-");
    const { release, ffi, runner, commands } = await fakeRelease();
    await resolveBoxLinuxBuild({}, { runner, home, release, ffi });
    commands.length = 0;

    await resolveBoxLinuxBuild({}, { runner, home, release, ffi });

    expect(commands).toEqual([]);
  });

  test("installs nothing when an asset's checksum is not the pinned one", async () => {
    const home = await temp("box-home-");
    const { release, ffi, runner } = await fakeRelease();
    const pinned = { ...release, linux: { ...release.linux, sha256: "0".repeat(64) } };

    const result = resolveBoxLinuxBuild({}, { runner, home, release: pinned, ffi });

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

describe("resolveBoxDevBinary from the box release", () => {
  const mac = { platform: "darwin", arch: "arm64" };

  test("downloads this machine's build once, with its packs beside box, and returns its box", async () => {
    const home = await temp("box-home-");
    const { release, runner, commands } = await fakeRelease();

    const downloads: string[] = [];
    const box = await resolveBoxDevBinary(
      {},
      {
        runner,
        home,
        release,
        ...mac,
        onDownload: ({ url }) => downloads.push(url),
      },
    );
    expect(downloads).toEqual([
      `https://github.com/owner/box-releases/releases/download/v${VERSION}/box-v${VERSION}-aarch64-apple-darwin.tar.gz`,
    ]);

    const root = join(home, ".agentcore", "box", `${VERSION}-aarch64-apple-darwin`);
    expect(box).toBe(join(root, "box"));
    expect(existsSync(join(root, "resources", "shared", "base", "pack.toml"))).toBe(true);
    // Windows has no mode bits.
    if (process.platform !== "win32") {
      for (const binary of BINARIES) {
        expect((await stat(join(root, binary))).mode & 0o777).toBe(0o755);
      }
    }
    expect(
      commands.filter((command) => command[0] === "curl").map((command) => command.at(-1)),
    ).toEqual([
      `https://github.com/owner/box-releases/releases/download/v${VERSION}/box-v${VERSION}-aarch64-apple-darwin.tar.gz`,
    ]);

    commands.length = 0;
    const later: string[] = [];
    const again = await resolveBoxDevBinary(
      {},
      {
        runner,
        home,
        release,
        ...mac,
        onDownload: ({ url }) => later.push(url),
      },
    );
    expect(again).toBe(box);
    expect(commands).toEqual([]);
    expect(later).toEqual([]);
  });

  test("is undefined on a machine the release has no build for, so dev runs box from PATH", async () => {
    const home = await temp("box-home-");
    const { release, runner, commands } = await fakeRelease();

    const box = await resolveBoxDevBinary(
      {},
      { runner, home, release, platform: "linux", arch: "x64" },
    );

    expect(box).toBeUndefined();
    expect(commands).toEqual([]);
  });

  test("installs nothing when the build's checksum is not the pinned one", async () => {
    const home = await temp("box-home-");
    const { release, runner } = await fakeRelease();
    const pinned = {
      ...release,
      dev: { "darwin-arm64": { ...release.dev["darwin-arm64"]!, sha256: "0".repeat(64) } },
    };

    const result = resolveBoxDevBinary({}, { runner, home, release: pinned, ...mac });

    await expect(result).rejects.toThrow(/not the pinned 0{64}\. Nothing was installed/);
    expect(existsSync(join(home, ".agentcore", "box", `${VERSION}-aarch64-apple-darwin`))).toBe(
      false,
    );
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
    const mac = "c".repeat(64);
    const { runner, urls } = sumsServer(
      `${linux}  box-v2.0.0-aarch64-unknown-linux-gnu.tar.gz\n` +
        `${mac}  box-v2.0.0-aarch64-apple-darwin.tar.gz\n`,
    );

    const release = await boxReleaseFor("2.0.0", {}, { runner, home });

    expect(urls).toEqual([
      `https://github.com/${BOX_RELEASE.repo}/releases/download/v2.0.0/SHA256SUMS.txt`,
    ]);
    expect(release.version).toBe("2.0.0");
    expect(release.linux).toEqual({
      target: "aarch64-unknown-linux-gnu",
      asset: "box-v2.0.0-aarch64-unknown-linux-gnu.tar.gz",
      sha256: linux,
    });
    expect(release.dev["darwin-arm64"]).toEqual({
      target: "aarch64-apple-darwin",
      asset: "box-v2.0.0-aarch64-apple-darwin.tar.gz",
      sha256: mac,
    });
  });

  test("refuses a version whose release lists no Linux box", async () => {
    const home = await temp("box-home-");
    const { runner } = sumsServer(`${"c".repeat(64)}  box-v2.0.0-aarch64-apple-darwin.tar.gz\n`);

    await expect(boxReleaseFor("2.0.0", {}, { runner, home })).rejects.toThrow(
      /box 2\.0\.0, which agentcore\.json names under box\.version, has no box-v2\.0\.0-aarch64-unknown-linux-gnu\.tar\.gz/,
    );
  });
});

describe("the pinned releases", () => {
  test("box and the ffi shim are pinned on their own, with a shim for each Python box runs", () => {
    expect(BOX_RELEASE.linux.asset).toContain(BOX_RELEASE.version);
    expect(Object.keys(FFI_RELEASE.pythons)).toContain("PYTHON_3_14");
  });
});
