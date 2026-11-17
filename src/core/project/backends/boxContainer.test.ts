import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBoxGatewayBedrockEntry } from "../../../handlers/project/box-gateway-test-support";
import type { Project } from "../../../handlers/project/types";
import type { BoxNetwork } from "../boxNetwork";
import { renderRuntimeBoxProfile } from "../templates/boxProfile";
import { stageBoxContainers } from "./boxContainer";
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
      agentCoreGateways: [getBoxGatewayBedrockEntry("agent")],
    },
  } as unknown as Project;
}

const BOX_DOCKERFILE = "FROM scratch\nCOPY .box-dist/profile.toml /opt/box/\n";
const BINARIES = ["box", "strands-box-sock-alias", "strands-box-contain-trampoline"];
/** What the box release unpacks, as build and deploy resolve it. */
const STAGED = [
  "box",
  "profile.toml",
  "resources",
  "strands-box-contain-trampoline",
  "strands-box-sock-alias",
];

/** A Linux box build: its programs, and its packs. */
async function linuxBuild(): Promise<BoxLinuxBuild> {
  const root = await temp("box-build-");
  for (const binary of BINARIES) await writeFile(join(root, binary), `#!${binary}\n`);
  await mkdir(join(root, "resources", "shared", "base"), { recursive: true });
  await writeFile(join(root, "resources", "shared", "base", "pack.toml"), "[pack]\n");
  return { binaries: root, resources: join(root, "resources"), ffi: {} };
}

/** The box getter build and deploy pass, which records the version each runtime asks for. */
async function boxOf() {
  const build = await linuxBuild();
  const versions: (string | undefined)[] = [];
  const box = async (version: string | undefined) => {
    versions.push(version);
    return build;
  };
  return { box, versions };
}

describe("stageBoxContainers", () => {
  test("stages box of the runtime's box.version, its packs, and the Runtime profile into the build context", async () => {
    const demo = await project(BOX_DOCKERFILE);
    demo.spec.runtimes[0]!.box = { version: "2.0.0" };
    const { box, versions } = await boxOf();

    expect(await stageBoxContainers(demo, [], box)).toEqual(["agent"]);

    expect(versions).toEqual(["2.0.0"]);
    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    expect(await readFile(join(dist, "profile.toml"), "utf8")).toBe(
      renderRuntimeBoxProfile(demo.spec, demo.spec.runtimes[0]!),
    );
    expect((await readdir(dist)).sort()).toEqual(STAGED);
    expect(await readFile(join(dist, "resources", "shared", "base", "pack.toml"), "utf8")).toBe(
      "[pack]\n",
    );
  });

  test("replaces what an earlier build staged", async () => {
    const demo = await project(BOX_DOCKERFILE);
    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    await mkdir(join(dist, "resources"), { recursive: true });
    await writeFile(join(dist, "box"), "old");
    await writeFile(join(dist, "stale.dw"), "old");

    await stageBoxContainers(demo, [], (await boxOf()).box);

    expect((await readdir(dist)).sort()).toEqual(STAGED);
    expect(await readFile(join(dist, "box"), "utf8")).toBe("#!box\n");
  });

  test("stages nothing for an image that does not copy .box-dist/", async () => {
    const demo = await project("FROM scratch\n");

    const { box, versions } = await boxOf();
    expect(await stageBoxContainers(demo, [], box)).toEqual([]);
    expect(versions).toEqual([]);
    expect(existsSync(join(demo.rootPath, "app", "agent", ".box-dist"))).toBe(false);
  });

  test("copies each policy file of the model beside the profile, for an image that copies .box-dist/ whole", async () => {
    const demo = await project(TEMPLATE_DOCKERFILE);
    await writeFile(join(demo.rootPath, "app", "agent", "start.sh"), START_SH);
    await mkdir(join(demo.rootPath, ".box"), { recursive: true });
    await writeFile(join(demo.rootPath, ".box", "policy.dw"), "// rules\n");

    await stageBoxContainers(demo, [model(["policy.dw"])], (await boxOf()).box);

    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    expect((await readdir(dist)).sort()).toEqual(["policy.dw", ...STAGED].sort());
    expect(await readFile(join(dist, "policy.dw"), "utf8")).toBe("// rules\n");
  });

  test("refuses an image that copies only the profile when policy files go with it", async () => {
    const demo = await project(BOX_DOCKERFILE);
    await mkdir(join(demo.rootPath, ".box"), { recursive: true });
    await writeFile(join(demo.rootPath, ".box", "policy.dw"), "// rules\n");

    await expect(
      stageBoxContainers(demo, [model(["policy.dw"])], (await boxOf()).box),
    ).rejects.toThrow("does not copy .box-dist/ whole into the image");
    expect(existsSync(join(demo.rootPath, "app", "agent", ".box-dist"))).toBe(false);
  });
});

const TEMPLATES = join(import.meta.dir, "..", "..", "..", "assets", "templates");
/** The container start.sh and the Dockerfile that `agentcore create` writes. */
const START_SH = readFileSync(join(TEMPLATES, "box-container", "start.sh"), "utf8");
const TEMPLATE_DOCKERFILE = readFileSync(
  join(TEMPLATES, "agent-python-strands", "Dockerfile.template"),
  "utf8",
);

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
