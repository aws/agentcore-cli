import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boxGatewaySpec } from "../../../projectSchemas/project";
import type { Project } from "../../../handlers/project/types";
import type { BoxNetwork } from "../boxNetwork";
import { renderAgentCorePack } from "../templates/boxProfile";
import { serializeRuntimeProfile } from "../runtimeProfile/serialize";
import { stageBoxContainers } from "./boxContainer";
import { BOX_RELEASE } from "./boxRelease";

/** The staged path of the generated @box/agentcore pack, from `.box-dist/`. */
const PACK_PATH = join("resources", "packs", "agentcore", "pack.toml");

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
          // create writes box.version only for the box container template, whose image copies box.
          ...(dockerfile.includes(".box-dist") && { box: { version: "1.0.0" } }),
        },
      ],
      memories: [],
      projectType: "box",
      agentCoreGateways: [boxGatewaySpec("agent")],
    },
  } as unknown as Project;
}

const BOX_DOCKERFILE = "FROM scratch\nCOPY .box-dist/profile.toml /opt/box/\n";
/** What build and deploy stage beside the Dockerfile. */
const STAGED = ["box-release.env", "profile.toml"];

describe("stageBoxContainers", () => {
  test("stages the pinned box release, whatever box.version names, and the Runtime profile, into the build context", async () => {
    const demo = await project(BOX_DOCKERFILE);
    demo.spec.runtimes[0]!.box = { version: "2.0.0" };

    expect(await stageBoxContainers(demo, [model([])], BOX_RELEASE)).toEqual(["agent"]);

    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    // The Runtime profile is the one build derived from the local profile.
    const { runtimeProfile, runtimeProfileHeader } = model([]);
    expect(await readFile(join(dist, "profile.toml"), "utf8")).toBe(
      serializeRuntimeProfile(runtimeProfile!, runtimeProfileHeader),
    );
    expect(await readFile(join(dist, "box-release.env"), "utf8")).toBe(
      `BOX_REPO=${BOX_RELEASE.repo}\nBOX_VERSION=${BOX_RELEASE.version}\nBOX_ASSET=${BOX_RELEASE.linux.asset}\n` +
        `BOX_SHA256=${BOX_RELEASE.linux.sha256}\n`,
    );
    // The container also stages the @box/agentcore pack, beside box's own packs in the image.
    expect(await readFile(join(dist, PACK_PATH), "utf8")).toBe(renderAgentCorePack(demo.spec));
    expect((await readdir(dist)).sort()).toEqual([...STAGED, "resources"].sort());
    // The runtime's .box/agent/aws/ holds a copy of what the profile writer stages, and no box.
    const aws = join(demo.rootPath, ".box", "agent", "aws");
    expect(await Bun.file(join(aws, "box-release.env")).exists()).toBe(false);
    for (const file of ["profile.toml", PACK_PATH]) {
      expect(await readFile(join(aws, file), "utf8")).toBe(
        await readFile(join(dist, file), "utf8"),
      );
    }
  });

  test("replaces what an earlier build staged", async () => {
    const demo = await project(BOX_DOCKERFILE);
    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    await mkdir(join(dist, "stale"), { recursive: true });
    await writeFile(join(dist, "box"), "old");
    await writeFile(join(dist, "stale.dw"), "old");

    await stageBoxContainers(demo, [model([])], BOX_RELEASE);

    expect((await readdir(dist)).sort()).toEqual([...STAGED, "resources"].sort());
  });

  test("stages nothing for a user's image that copies .box-dist/ but has no box.version", async () => {
    const demo = await project(BOX_DOCKERFILE);
    delete demo.spec.runtimes[0]!.box;

    expect(await stageBoxContainers(demo, [model([])], BOX_RELEASE)).toEqual([]);
  });

  test("stages nothing for a runtime with no box.version", async () => {
    const demo = await project("FROM scratch\n");

    expect(await stageBoxContainers(demo, [model([])], BOX_RELEASE)).toEqual([]);
    expect(existsSync(join(demo.rootPath, "app", "agent", ".box-dist"))).toBe(false);
  });

  test("copies each policy file of the model beside the profile, for an image that copies .box-dist/ whole", async () => {
    const demo = await project(TEMPLATE_DOCKERFILE);
    await mkdir(join(demo.rootPath, ".box", "agent", "local"), { recursive: true });
    await writeFile(join(demo.rootPath, ".box", "agent", "local", "policy.dw"), "// rules\n");

    await stageBoxContainers(demo, [model(["policy.dw"])], BOX_RELEASE);

    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    expect((await readdir(dist)).sort()).toEqual(["policy.dw", ...STAGED, "resources"].sort());
    expect(await readFile(join(dist, "policy.dw"), "utf8")).toBe("// rules\n");
  });

  test("refuses an image that copies only the profile when policy files go with it", async () => {
    const demo = await project(BOX_DOCKERFILE);
    await mkdir(join(demo.rootPath, ".box", "agent", "local"), { recursive: true });
    await writeFile(join(demo.rootPath, ".box", "agent", "local", "policy.dw"), "// rules\n");

    await expect(stageBoxContainers(demo, [model(["policy.dw"])], BOX_RELEASE)).rejects.toThrow(
      "does not copy .box-dist/ whole into the image",
    );
    expect(existsSync(join(demo.rootPath, "app", "agent", ".box-dist"))).toBe(false);
  });
});

const TEMPLATES = join(import.meta.dir, "..", "..", "..", "assets", "templates");
/** The container Dockerfile that `agentcore create` writes, which copies `.box-dist/` whole. */
const TEMPLATE_DOCKERFILE = readFileSync(
  join(TEMPLATES, "agent-python-strands-box", "Dockerfile.template"),
  "utf8",
);

/**
 * A model of runtime `agent` with no host and the policy files given, with the Runtime profile build
 * derived from its local profile.
 */
function model(policyFiles: string[]): BoxNetwork {
  return {
    runtime: "agent",
    gateway: "agent-box-egress",
    region: "us-west-2",
    hosts: [],
    envRoutes: [],
    policyFiles,
    runtimeProfile: {
      packs: ["@box/base", "@box/agentcore"],
      ...(policyFiles.length > 0 && { policies: policyFiles }),
      profile: { name: "demo" },
    },
    runtimeProfileHeader: ["Derived from .box/agent/local/profile.toml."],
    grantedActions: [],
    warnings: [],
    failures: [],
  };
}
