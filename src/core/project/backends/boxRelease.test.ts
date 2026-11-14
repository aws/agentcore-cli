import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidEnvironmentError } from "../../../errors/errors";
import { type ProcessRunner, runProcess } from "../../../io/exec";
import { type BoxRelease, resolveBoxLinuxBuild } from "./boxRelease";

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
  const box = await tarball(
    `box-v${VERSION}-aarch64-unknown-linux-gnu.tar.gz`,
    boxFiles ?? {
      ...Object.fromEntries(BINARIES.map((binary) => [binary, `#!${binary}\n`])),
      "resources/shared/base/pack.toml": "[pack]\n",
      "release.json": JSON.stringify({ box_version: VERSION }),
    },
  );
  const ffi = await tarball("box-ffi-python3.14-aarch64-unknown-linux-gnu.tar.gz", {
    "libffi.so.8": "ffi",
  });
  const release: BoxRelease = {
    repo: "owner/staging-boxy",
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
  // gh copies the asset into --dir; tar runs for real.
  const runner: ProcessRunner = async (command, options) => {
    commands.push(command);
    if (command[0] !== "gh") return runProcess(command, options);
    const asset = command[command.indexOf("--pattern") + 1]!;
    const into = command[command.indexOf("--dir") + 1]!;
    await writeFile(join(into, asset), await readFile(assets[asset]!));
  };
  return { release, runner, commands };
}

describe("resolveBoxLinuxBuild from the box release", () => {
  test("downloads both assets with gh, checks them, and installs them under ~/.agentcore/box", async () => {
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
    expect(commands.filter((command) => command[0] === "gh")).toEqual(
      [release.box.asset, release.ffi.asset].map((asset) => [
        "gh",
        "release",
        "download",
        `v${VERSION}`,
        "--repo",
        "owner/staging-boxy",
        "--pattern",
        asset,
        "--dir",
        expect.any(String) as unknown as string,
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

  test("says how to log in when gh cannot download the release", async () => {
    const home = await temp("box-home-");
    const { release } = await fakeRelease();
    const runner: ProcessRunner = async () => {
      throw new Error("HTTP 404: Not Found");
    };

    const result = resolveBoxLinuxBuild({}, { runner, home, release });

    await expect(result).rejects.toThrow(
      /Run `gh auth login` with an account that can read owner\/staging-boxy/,
    );
    await expect(result).rejects.toThrow(/HTTP 404: Not Found/);
  });
});

describe("resolveBoxLinuxBuild from AGENTCORE_BOX_SOURCE", () => {
  async function boxSource(): Promise<string> {
    const source = await temp("box-source-");
    await mkdir(join(source, "target-al2023", "release"), { recursive: true });
    for (const binary of BINARIES) {
      await writeFile(join(source, "target-al2023", "release", binary), `#!${binary}\n`);
    }
    await mkdir(join(source, "resources"), { recursive: true });
    return source;
  }

  test("uses the local build and downloads nothing", async () => {
    const source = await boxSource();
    const runner: ProcessRunner = async () => {
      throw new Error("not run");
    };

    const build = await resolveBoxLinuxBuild({ AGENTCORE_BOX_SOURCE: source }, { runner });

    expect(build.binaries).toBe(join(source, "target-al2023", "release"));
    expect(build.ffi).toEqual({});
  });

  test("names the binary the local build lacks", async () => {
    const source = await boxSource();
    await rm(join(source, "target-al2023", "release", "strands-box-sock-alias"));

    await expect(resolveBoxLinuxBuild({ AGENTCORE_BOX_SOURCE: source })).rejects.toThrow(
      /has no .*target-al2023\/release\/strands-box-sock-alias/,
    );
  });
});
