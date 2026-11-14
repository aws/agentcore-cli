import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidEnvironmentError } from "../../../errors/errors";
import { getBoxGatewayBedrockEntry } from "../../../handlers/project/shortcuts";
import type { Project } from "../../../handlers/project/types";
import { renderRuntimeBoxProfile } from "../templates/boxProfile";
import { stageBoxCodeZip } from "./boxCodeZip";

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

/** A staging-boxy checkout with an Amazon Linux 2023 build, its packs, and optionally the shim. */
async function boxSource(options: { ffi?: boolean } = {}): Promise<string> {
  const source = await temp("box-source-");
  await mkdir(join(source, "target-al2023", "release"), { recursive: true });
  for (const binary of BINARIES) {
    await writeFile(join(source, "target-al2023", "release", binary), `#!${binary}\n`);
  }
  await mkdir(join(source, "resources", "shared", "base"), { recursive: true });
  await writeFile(join(source, "resources", "shared", "base", "pack.toml"), "[pack]\n");
  if (options.ffi) {
    await mkdir(join(source, "target-al2023", "ffi"), { recursive: true });
    await writeFile(join(source, "target-al2023", "ffi", "libffi.so.8"), "ffi");
  }
  return source;
}

async function project(entrypoint: string): Promise<Project> {
  const rootPath = await temp("box-project-");
  await mkdir(join(rootPath, "app", "agent"), { recursive: true });
  return {
    name: "demo",
    rootPath,
    spec: {
      name: "demo",
      runtimes: [
        {
          name: "agent",
          build: "CodeZip",
          entrypoint,
          codeLocation: "app/agent",
          modelProvider: "Bedrock",
        },
      ],
      memories: [],
      agentCoreGateways: [getBoxGatewayBedrockEntry("agent")],
    },
  } as unknown as Project;
}

describe("stageBoxCodeZip", () => {
  test("stages box, its packs, the shim, and the Runtime profile into the code folder", async () => {
    const source = await boxSource({ ffi: true });
    const demo = await project("start.py");

    expect(stageBoxCodeZip(demo, { AGENTCORE_BOX_SOURCE: source })).toEqual(["agent"]);

    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    for (const binary of BINARIES) {
      expect(await readFile(join(dist, binary), "utf8")).toBe(`#!${binary}\n`);
      // The zip keeps file modes, so box stays runnable on the Runtime.
      expect((await stat(join(dist, binary))).mode & 0o777).toBe(0o755);
    }
    expect(await readFile(join(dist, "resources", "shared", "base", "pack.toml"), "utf8")).toBe(
      "[pack]\n",
    );
    expect(await readFile(join(dist, "ffi", "libffi.so.8"), "utf8")).toBe("ffi");
    // The Runtime profile is rendered from agentcore.json.
    expect(await readFile(join(dist, "profile.toml"), "utf8")).toBe(
      renderRuntimeBoxProfile(demo.spec, demo.spec.runtimes[0]!, demo.rootPath),
    );
  });

  test("replaces what an earlier deploy staged", async () => {
    const demo = await project("start.py");
    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    await mkdir(join(dist, "ffi"), { recursive: true });
    await writeFile(join(dist, "ffi", "stale.so"), "old");

    stageBoxCodeZip(demo, { AGENTCORE_BOX_SOURCE: await boxSource() });

    expect(await Bun.file(join(dist, "ffi", "stale.so")).exists()).toBe(false);
    expect(await Bun.file(join(dist, "box")).exists()).toBe(true);
  });

  test("stages nothing for a runtime that does not start box", async () => {
    const demo = await project("main.py");

    // No AGENTCORE_BOX_SOURCE is needed, and nothing is written.
    expect(stageBoxCodeZip(demo, {})).toEqual([]);
    expect(await Bun.file(join(demo.rootPath, "app", "agent", ".box-dist", "box")).exists()).toBe(
      false,
    );
  });

  test("refuses a runtime that starts box when AGENTCORE_BOX_SOURCE is unset", async () => {
    const demo = await project("start.py");

    expect(() => stageBoxCodeZip(demo, {})).toThrow(InvalidEnvironmentError);
    expect(() => stageBoxCodeZip(demo, {})).toThrow(/Set AGENTCORE_BOX_SOURCE/);
  });

  test("names the binary AGENTCORE_BOX_SOURCE lacks", async () => {
    const source = await boxSource();
    await rm(join(source, "target-al2023", "release", "strands-box-sock-alias"));
    const demo = await project("start.py");

    expect(() => stageBoxCodeZip(demo, { AGENTCORE_BOX_SOURCE: source })).toThrow(
      /has no .*target-al2023\/release\/strands-box-sock-alias/,
    );
  });
});
