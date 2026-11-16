import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getBoxGatewayBedrockEntry } from "../../../handlers/project/shortcuts";
import type { Project } from "../../../handlers/project/types";
import type { BoxNetwork } from "../boxNetwork";
import { renderRuntimeBoxProfile } from "../templates/boxProfile";
import { stageBoxCodeZip } from "./boxCodeZip";
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

/** A box build folder, with its binaries, its packs, and optionally the shim. */
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
        },
      ],
      memories: [],
      agentCoreGateways: [getBoxGatewayBedrockEntry("agent")],
    },
  } as unknown as Project;
}

/** A box build laid out as deploy resolves it. */
async function sourceBuild(options: { ffi?: boolean } = {}): Promise<BoxLinuxBuild> {
  const source = await boxSource(options);
  const ffi = join(source, "target-al2023", "ffi");
  return {
    binaries: join(source, "target-al2023", "release"),
    resources: join(source, "resources"),
    ffi: options.ffi ? { PYTHON_3_14: ffi } : {},
  };
}

describe("stageBoxCodeZip", () => {
  test("stages box, its packs, the shim, and the Runtime profile into the code folder", async () => {
    const build = await sourceBuild({ ffi: true });
    const demo = await project("start.py");

    expect(await stageBoxCodeZip(demo, [], async () => build)).toEqual(["agent"]);

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
      renderRuntimeBoxProfile(demo.spec, demo.spec.runtimes[0]!),
    );
  });

  test("asks for the box of the runtime's box.version", async () => {
    const build = await sourceBuild({ ffi: true });
    const demo = await project("start.py");
    demo.spec.runtimes[0]!.box = { version: "2.0.0" };
    const versions: (string | undefined)[] = [];

    await stageBoxCodeZip(demo, [], async (version) => {
      versions.push(version);
      return build;
    });

    expect(versions).toEqual(["2.0.0"]);
  });

  test("ships no shim to a runtime whose Python it was not built for", async () => {
    const build = await sourceBuild({ ffi: true });
    const demo = await project("start.py", "PYTHON_3_13");

    await stageBoxCodeZip(demo, [], async () => build);

    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    expect(await Bun.file(join(dist, "box")).exists()).toBe(true);
    expect(await Bun.file(join(dist, "ffi", "libffi.so.8")).exists()).toBe(false);
  });

  test("replaces what an earlier deploy staged", async () => {
    const demo = await project("start.py");
    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    await mkdir(join(dist, "ffi"), { recursive: true });
    await writeFile(join(dist, "ffi", "stale.so"), "old");
    const build = await sourceBuild();

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
    const build = await sourceBuild();
    const demo = await project("start.py");
    await mkdir(join(demo.rootPath, ".box", "rules"), { recursive: true });
    const bytes = Buffer.from([0x2f, 0x2f, 0x20, 0xe2, 0x9c, 0x93, 0x0d, 0x0a]);
    await writeFile(join(demo.rootPath, ".box", "policy.dw"), bytes);
    await writeFile(join(demo.rootPath, ".box", "rules", "extra.dw"), "// extra\n");
    await writeFile(join(demo.rootPath, "app", "agent", "start.sh"), START_SH);

    await stageBoxCodeZip(demo, [model(["policy.dw", "rules/extra.dw"])], async () => build);

    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    expect(Buffer.compare(await readFile(join(dist, "policy.dw")), bytes)).toBe(0);
    expect(await readFile(join(dist, "rules", "extra.dw"), "utf8")).toBe("// extra\n");
    expect(await readFile(join(dist, "profile.toml"), "utf8")).toContain(
      'policies = ["policy.dw", "rules/extra.dw"]',
    );
  });

  test("stages no policy file and names none when the model has none", async () => {
    const build = await sourceBuild();
    const demo = await project("start.py");

    await stageBoxCodeZip(demo, [model([])], async () => build);

    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    expect(await readFile(join(dist, "profile.toml"), "utf8")).not.toContain("policies");
  });

  test("refuses an older start.sh before it asks for box, and stages nothing", async () => {
    const demo = await project("start.py");
    await mkdir(join(demo.rootPath, ".box"), { recursive: true });
    await writeFile(join(demo.rootPath, ".box", "policy.dw"), "// rules\n");
    await writeFile(
      join(demo.rootPath, "app", "agent", "start.sh"),
      "#!/bin/bash\nwrite_profile\n",
    );
    const box = mock(async (): Promise<BoxLinuxBuild> => sourceBuild());

    await expect(stageBoxCodeZip(demo, [model(["policy.dw"])], box)).rejects.toThrow(
      "copies no policy file of .box/profile.toml (policy.dw)",
    );
    expect(box).not.toHaveBeenCalled();
    expect(
      await Bun.file(join(demo.rootPath, "app", "agent", ".box-dist", "profile.toml")).exists(),
    ).toBe(false);
  });
});

/** The CodeZip start.sh that `agentcore create` writes. */
const START_SH = readFileSync(
  join(import.meta.dir, "..", "..", "..", "assets", "templates", "box-codezip", "start.sh"),
  "utf8",
);

/** A model of runtime `agent` with the default Memory route and the policy files given. */
function model(policyFiles: string[]): BoxNetwork {
  return {
    runtime: "agent",
    gateway: "agent-box",
    region: "us-west-2",
    hosts: [],
    credentials: [],
    policyFiles,
    grantedActions: [],
    warnings: [],
    failures: [],
  };
}
