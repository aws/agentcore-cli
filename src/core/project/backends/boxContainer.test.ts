import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidEnvironmentError } from "../../../errors/errors";
import { getBoxGatewaySpec } from "../../../handlers/project/shortcuts";
import type { Project } from "../../../handlers/project/types";
import { renderRuntimeBoxProfile } from "../templates/boxProfile";
import { stageBoxContainers } from "./boxContainer";

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

async function boxSource(): Promise<string> {
  const source = await temp("box-source-");
  await mkdir(join(source, "target-al2023", "release"), { recursive: true });
  for (const binary of BINARIES) {
    await writeFile(join(source, "target-al2023", "release", binary), `#!${binary}\n`);
  }
  await mkdir(join(source, "target-al2023", "ffi"), { recursive: true });
  await writeFile(join(source, "target-al2023", "ffi", "libffi.so.8"), "ffi");
  await mkdir(join(source, "resources", "shared", "base"), { recursive: true });
  await writeFile(join(source, "resources", "shared", "base", "pack.toml"), "[pack]\n");
  return source;
}

async function project(dockerfile: string): Promise<Project> {
  const rootPath = await temp("box-project-");
  await mkdir(join(rootPath, "app", "agent"), { recursive: true });
  await writeFile(join(rootPath, "app", "agent", "Dockerfile"), dockerfile);
  return {
    name: "demo",
    rootPath,
    spec: {
      name: "demo",
      runtimes: [
        {
          name: "agent",
          build: "Container",
          entrypoint: "main.py",
          codeLocation: "app/agent",
          dockerfile: "Dockerfile",
          modelProvider: "Bedrock",
        },
      ],
      memories: [],
      agentCoreGateways: [getBoxGatewaySpec({ bedrockTarget: true })],
    },
  } as unknown as Project;
}

const BOX_DOCKERFILE = "FROM scratch\nCOPY .box-dist/box /opt/box/\n";

describe("stageBoxContainers", () => {
  test("stages box, its packs, and the Runtime profile into the build context", async () => {
    const demo = await project(BOX_DOCKERFILE);

    expect(stageBoxContainers(demo, { AGENTCORE_BOX_SOURCE: await boxSource() })).toEqual([
      "agent",
    ]);

    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    for (const binary of BINARIES) {
      expect(await readFile(join(dist, binary), "utf8")).toBe(`#!${binary}\n`);
      expect((await stat(join(dist, binary))).mode & 0o777).toBe(0o755);
    }
    expect(await readFile(join(dist, "resources", "shared", "base", "pack.toml"), "utf8")).toBe(
      "[pack]\n",
    );
    // The Runtime profile is rendered from agentcore.json.
    expect(await readFile(join(dist, "profile.toml"), "utf8")).toBe(
      renderRuntimeBoxProfile(demo.spec, demo.spec.runtimes[0]!),
    );
    // The image's own Python needs no libffi shim.
    expect(await Bun.file(join(dist, "ffi", "libffi.so.8")).exists()).toBe(false);
  });

  test("stages nothing for an image that does not copy box", async () => {
    const demo = await project("FROM scratch\n");

    expect(stageBoxContainers(demo, {})).toEqual([]);
    expect(await Bun.file(join(demo.rootPath, "app", "agent", ".box-dist", "box")).exists()).toBe(
      false,
    );
  });

  test("refuses a box image when AGENTCORE_BOX_SOURCE is unset", async () => {
    const demo = await project(BOX_DOCKERFILE);

    expect(() => stageBoxContainers(demo, {})).toThrow(InvalidEnvironmentError);
    expect(() => stageBoxContainers(demo, {})).toThrow(/Set AGENTCORE_BOX_SOURCE/);
  });
});
