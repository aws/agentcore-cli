import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBoxGatewayBedrockEntry } from "../../../handlers/project/shortcuts";
import type { Project } from "../../../handlers/project/types";
import type { BoxNetwork } from "../boxNetwork";
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

describe("stageBoxContainers", () => {
  test("stages only the Runtime profile into the build context; the image installs box", async () => {
    const demo = await project(BOX_DOCKERFILE);

    expect(stageBoxContainers(demo, [])).toEqual(["agent"]);

    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    // The Runtime profile is rendered from agentcore.json.
    expect(await readFile(join(dist, "profile.toml"), "utf8")).toBe(
      renderRuntimeBoxProfile(demo.spec, demo.spec.runtimes[0]!),
    );
    expect(await readdir(dist)).toEqual(["profile.toml"]);
  });

  test("replaces what an earlier build staged", async () => {
    const demo = await project(BOX_DOCKERFILE);
    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    await mkdir(join(dist, "resources"), { recursive: true });
    await writeFile(join(dist, "box"), "old");

    stageBoxContainers(demo, []);

    expect(await readdir(dist)).toEqual(["profile.toml"]);
  });

  test("stages nothing for an image that does not copy .box-dist/", async () => {
    const demo = await project("FROM scratch\n");

    expect(stageBoxContainers(demo, [])).toEqual([]);
    expect(existsSync(join(demo.rootPath, "app", "agent", ".box-dist"))).toBe(false);
  });

  test("copies each policy file of the model beside the profile, for an image that copies .box-dist/ whole", async () => {
    const demo = await project(TEMPLATE_DOCKERFILE);
    await writeFile(join(demo.rootPath, "app", "agent", "start.sh"), START_SH);
    await mkdir(join(demo.rootPath, ".box"), { recursive: true });
    await writeFile(join(demo.rootPath, ".box", "policy.dw"), "// rules\n");

    stageBoxContainers(demo, [model(["policy.dw"])]);

    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    expect((await readdir(dist)).sort()).toEqual(["policy.dw", "profile.toml"]);
    expect(await readFile(join(dist, "policy.dw"), "utf8")).toBe("// rules\n");
  });

  test("refuses an image that copies only the profile when policy files go with it", async () => {
    const demo = await project(BOX_DOCKERFILE);
    await mkdir(join(demo.rootPath, ".box"), { recursive: true });
    await writeFile(join(demo.rootPath, ".box", "policy.dw"), "// rules\n");

    expect(() => stageBoxContainers(demo, [model(["policy.dw"])])).toThrow(
      "does not copy .box-dist/ whole into the image",
    );
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
    hosts: [],
    credentials: [],
    policyFiles,
    grantedActions: [],
    warnings: [],
    failures: [],
  };
}
