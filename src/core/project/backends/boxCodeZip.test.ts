import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boxGatewaySpec } from "../../../projectSchemas/project";
import type { Project } from "../../../handlers/project/types";
import type { BoxNetwork } from "../boxNetwork";
import {
  AGENTCORE_CODEZIP_PACK_PATH,
  AGENTCORE_PACK_PATH,
  renderAgentCoreCodeZipPack,
  renderAgentCorePack,
  renderRuntimeBoxProfile,
} from "../templates/boxProfile";
import { BOX_DIST_GITIGNORE, stageBoxCodeZip } from "./boxCodeZip";
import type { BoxLinuxBuild } from "./boxRelease";

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

/**
 * A Linux box build laid out as the release cache holds it, and as deploy resolves it: box, its
 * helpers and its packs in one folder.
 */
async function linuxBuild(): Promise<BoxLinuxBuild> {
  const root = await temp("box-build-");
  for (const binary of BINARIES) await writeFile(join(root, binary), `#!${binary}\n`);
  await mkdir(join(root, "resources", "shared", "base"), { recursive: true });
  await writeFile(join(root, "resources", "shared", "base", "pack.toml"), "[pack]\n");
  return { binaries: root, resources: join(root, "resources") };
}

async function project(entrypoint: string, runtimeVersion = "PYTHON_3_14"): Promise<Project> {
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
          runtimeVersion,
          modelProvider: "Bedrock",
          // create writes box.version only for a box template, whose entry point is start.py.
          ...(entrypoint === "start.py" && { box: { version: "1.0.0" } }),
        },
      ],
      memories: [],
      projectType: "box",
      agentCoreGateways: [boxGatewaySpec("agent")],
    },
  } as unknown as Project;
}

describe("stageBoxCodeZip", () => {
  test("stages box, its packs, and the Runtime profile into the code folder", async () => {
    const build = await linuxBuild();
    const demo = await project("start.py");

    expect(await stageBoxCodeZip(demo, [], async () => build)).toEqual(["agent"]);

    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    for (const binary of BINARIES) {
      expect(await readFile(join(dist, binary), "utf8")).toBe(`#!${binary}\n`);
      // The zip keeps file modes, so box stays runnable on the Runtime. Windows has no mode bits.
      if (process.platform !== "win32") {
        expect((await stat(join(dist, binary))).mode & 0o777).toBe(0o755);
      }
    }
    expect(await readFile(join(dist, "resources", "shared", "base", "pack.toml"), "utf8")).toBe(
      "[pack]\n",
    );
    // The Runtime profile is rendered from agentcore.json.
    expect(await readFile(join(dist, "profile.toml"), "utf8")).toBe(
      renderRuntimeBoxProfile(demo.spec, demo.spec.runtimes[0]!),
    );
    // The profile imports these generated packs, which box finds beside its binary. They are
    // written after box's own resources are copied, so the copy does not remove them.
    expect(await readFile(join(dist, AGENTCORE_PACK_PATH), "utf8")).toBe(
      renderAgentCorePack(demo.spec),
    );
    expect(await readFile(join(dist, AGENTCORE_CODEZIP_PACK_PATH), "utf8")).toBe(
      renderAgentCoreCodeZipPack(),
    );
    // A template's own .gitignore may not list .box-dist/, so the folder ignores itself.
    expect(await readFile(join(dist, ".gitignore"), "utf8")).toBe(BOX_DIST_GITIGNORE);
  });

  test("asks for the box of the runtime's box.version", async () => {
    const build = await linuxBuild();
    const demo = await project("start.py");
    demo.spec.runtimes[0]!.box = { version: "2.0.0" };
    const versions: (string | undefined)[] = [];

    await stageBoxCodeZip(demo, [], async (version) => {
      versions.push(version);
      return build;
    });

    expect(versions).toEqual(["2.0.0"]);
  });

  test.each([
    ["a user's own start.py, with no box.version", false, "box"],
    ["a box runtime outside a Box project", true, undefined],
  ] as const)("stages nothing for %s", async (_label, boxVersion, projectType) => {
    const demo = await project("start.py");
    const runtime = demo.spec.runtimes[0]!;
    if (!boxVersion) delete runtime.box;
    (demo.spec as { projectType?: string }).projectType = projectType;
    const asked: (string | undefined)[] = [];

    expect(
      await stageBoxCodeZip(demo, [], async (version) => {
        asked.push(version);
        return linuxBuild();
      }),
    ).toEqual([]);
    expect(asked).toEqual([]);
    expect(existsSync(join(demo.rootPath, "app", "agent", ".box-dist"))).toBe(false);
  });

  test("replaces what an earlier deploy staged", async () => {
    const demo = await project("start.py");
    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    await mkdir(join(dist, "ffi"), { recursive: true });
    await writeFile(join(dist, "ffi", "stale.so"), "old");
    const build = await linuxBuild();

    await stageBoxCodeZip(demo, [], async () => build);

    expect(await Bun.file(join(dist, "ffi", "stale.so")).exists()).toBe(false);
    expect(await Bun.file(join(dist, "box")).exists()).toBe(true);
  });

  test("asks for no box build for a runtime that does not start box", async () => {
    const demo = await project("main.py");
    const box = mock(async (): Promise<BoxLinuxBuild> => {
      throw new Error("not asked");
    });

    expect(await stageBoxCodeZip(demo, [], box)).toEqual([]);
    expect(box).not.toHaveBeenCalled();
    expect(await Bun.file(join(demo.rootPath, "app", "agent", ".box-dist", "box")).exists()).toBe(
      false,
    );
  });

  test("copies each policy file of the model, byte for byte, beside the profile that names it", async () => {
    const build = await linuxBuild();
    const demo = await project("start.py");
    const local = join(demo.rootPath, ".box", "agent", "local");
    await mkdir(join(local, "rules"), { recursive: true });
    const bytes = Buffer.from([0x2f, 0x2f, 0x20, 0xe2, 0x9c, 0x93, 0x0d, 0x0a]);
    await writeFile(join(local, "policy.dw"), bytes);
    await writeFile(join(local, "rules", "extra.dw"), "// extra\n");

    await stageBoxCodeZip(demo, [model(["policy.dw", "rules/extra.dw"])], async () => build);

    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    expect(Buffer.compare(await readFile(join(dist, "policy.dw")), bytes)).toBe(0);
    expect(await readFile(join(dist, "rules", "extra.dw"), "utf8")).toBe("// extra\n");
    expect(await readFile(join(dist, "profile.toml"), "utf8")).toContain(
      'policies = ["policy.dw", "rules/extra.dw"]',
    );
  });

  test("stages no policy file and names none when the model has none", async () => {
    const build = await linuxBuild();
    const demo = await project("start.py");

    await stageBoxCodeZip(demo, [model([])], async () => build);

    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    expect(await readFile(join(dist, "profile.toml"), "utf8")).not.toContain("policies");
  });
});

/** A model of runtime `agent` with no host and the policy files given. */
function model(policyFiles: string[]): BoxNetwork {
  return {
    runtime: "agent",
    gateway: "agent-box-egress",
    region: "us-west-2",
    hosts: [],
    envRoutes: [],
    policyFiles,
    grantedActions: [],
    warnings: [],
    failures: [],
  };
}
