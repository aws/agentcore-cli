import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBoxGatewayBedrockEntry } from "../../../handlers/project/box-gateway-test-support";
import type { Project } from "../../../handlers/project/types";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import type { BoxNetwork } from "../boxNetwork";
import { renderAgentCorePack, renderRuntimeBoxProfile } from "../templates/boxProfile";
import { boxTracesWarning, stageBoxContainers } from "./boxContainer";
import { BOX_RELEASE, type BoxRelease } from "./boxRelease";

/** The staged path of the generated box/agentcore pack, from `.box-dist/`. */
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
        },
      ],
      memories: [],
      agentCoreGateways: [getBoxGatewayBedrockEntry("agent")],
    },
  } as unknown as Project;
}

const BOX_DOCKERFILE = "FROM scratch\nCOPY .box-dist/profile.toml /opt/box/\n";
/** What build and deploy stage beside the Dockerfile. */
const STAGED = ["box-release.env", "profile.toml"];

/** The release getter build and deploy pass, which records the version each runtime asks for. */
function releaseOf() {
  const versions: (string | undefined)[] = [];
  const releaseFor = async (version: string | undefined): Promise<BoxRelease> => {
    versions.push(version);
    return { ...BOX_RELEASE, version: version ?? BOX_RELEASE.version };
  };
  return { releaseFor, versions };
}

describe("stageBoxContainers", () => {
  test("stages the box release of the runtime's box.version, and the Runtime profile, into the build context", async () => {
    const demo = await project(BOX_DOCKERFILE);
    demo.spec.runtimes[0]!.box = { version: "2.0.0" };
    const { releaseFor, versions } = releaseOf();

    expect(await stageBoxContainers(demo, [], releaseFor)).toEqual(["agent"]);

    expect(versions).toEqual(["2.0.0"]);
    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    // The Runtime profile is rendered from agentcore.json.
    expect(await readFile(join(dist, "profile.toml"), "utf8")).toBe(
      renderRuntimeBoxProfile(demo.spec, demo.spec.runtimes[0]!),
    );
    expect(await readFile(join(dist, "box-release.env"), "utf8")).toBe(
      `BOX_REPO=${BOX_RELEASE.repo}\nBOX_VERSION=2.0.0\nBOX_ASSET=${BOX_RELEASE.linux.asset}\n` +
        `BOX_SHA256=${BOX_RELEASE.linux.sha256}\n`,
    );
    // The container also stages the box/agentcore pack, beside box's own packs in the image.
    expect(await readFile(join(dist, PACK_PATH), "utf8")).toBe(renderAgentCorePack(demo.spec));
    expect((await readdir(dist)).sort()).toEqual([...STAGED, "resources"].sort());
  });

  test("replaces what an earlier build staged", async () => {
    const demo = await project(BOX_DOCKERFILE);
    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    await mkdir(join(dist, "stale"), { recursive: true });
    await writeFile(join(dist, "box"), "old");
    await writeFile(join(dist, "stale.dw"), "old");

    await stageBoxContainers(demo, [], releaseOf().releaseFor);

    expect((await readdir(dist)).sort()).toEqual([...STAGED, "resources"].sort());
  });

  test("stages nothing for an image that does not copy .box-dist/", async () => {
    const demo = await project("FROM scratch\n");

    const { releaseFor, versions } = releaseOf();
    expect(await stageBoxContainers(demo, [], releaseFor)).toEqual([]);
    expect(versions).toEqual([]);
    expect(existsSync(join(demo.rootPath, "app", "agent", ".box-dist"))).toBe(false);
  });

  test("copies each policy file of the model beside the profile, for an image that copies .box-dist/ whole", async () => {
    const demo = await project(TEMPLATE_DOCKERFILE);
    await mkdir(join(demo.rootPath, "box", "agent", "local"), { recursive: true });
    await writeFile(join(demo.rootPath, "box", "agent", "local", "policy.dw"), "// rules\n");

    await stageBoxContainers(demo, [model(["policy.dw"])], releaseOf().releaseFor);

    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    expect((await readdir(dist)).sort()).toEqual(["policy.dw", ...STAGED, "resources"].sort());
    expect(await readFile(join(dist, "policy.dw"), "utf8")).toBe("// rules\n");
  });

  test("refuses an image that copies only the profile when policy files go with it", async () => {
    const demo = await project(BOX_DOCKERFILE);
    await mkdir(join(demo.rootPath, "box", "agent", "local"), { recursive: true });
    await writeFile(join(demo.rootPath, "box", "agent", "local", "policy.dw"), "// rules\n");

    await expect(
      stageBoxContainers(demo, [model(["policy.dw"])], releaseOf().releaseFor),
    ).rejects.toThrow("does not copy .box-dist/ whole into the image");
    expect(existsSync(join(demo.rootPath, "app", "agent", ".box-dist"))).toBe(false);
  });
});

const TEMPLATES = join(import.meta.dir, "..", "..", "..", "assets", "templates");
/** The container Dockerfile that `agentcore create` writes, which copies `.box-dist/` whole. */
const TEMPLATE_DOCKERFILE = readFileSync(
  join(TEMPLATES, "agent-python-strands-box", "Dockerfile.template"),
  "utf8",
);

const PLAIN_DOCKERFILE = readFileSync(
  join(TEMPLATES, "agent-python-strands", "Dockerfile.template"),
  "utf8",
);

describe("boxTracesWarning", () => {
  const WARNING =
    "Runtime 'agent' runs its agent in a box under opentelemetry-instrument, but box sends the " +
    "agent's traces to its own collector, so they do not reach CloudWatch. Set " +
    "instrumentation.enableOtel to false to start the agent without it.";

  /** The project's one runtime, with `changes` applied. */
  async function runtimeOf(dockerfile: string, changes: Partial<ProjectRuntime> = {}) {
    const demo = await project(dockerfile);
    return { root: demo.rootPath, runtime: { ...demo.spec.runtimes[0]!, ...changes } };
  }

  test.each([
    ["the container image", TEMPLATE_DOCKERFILE, {}],
    ["the CodeZip start.py", PLAIN_DOCKERFILE, { build: "CodeZip", entrypoint: "start.py" }],
  ] as const)(
    "warns that a box keeps the traces when %s runs the agent in a box",
    async (_, dockerfile, changes) => {
      const { root, runtime } = await runtimeOf(dockerfile, changes);
      expect(boxTracesWarning(root, runtime)).toBe(WARNING);
      expect(boxTracesWarning(root, { ...runtime, instrumentation: { enableOtel: true } })).toBe(
        WARNING,
      );
    },
  );

  test.each([
    ["the container image", TEMPLATE_DOCKERFILE, {}],
    ["the CodeZip start.py", PLAIN_DOCKERFILE, { build: "CodeZip", entrypoint: "start.py" }],
  ] as const)(
    "does not warn when enableOtel is false and %s runs the agent in a box",
    async (_, dockerfile, changes) => {
      const { root, runtime } = await runtimeOf(dockerfile, {
        ...changes,
        instrumentation: { enableOtel: false },
      });
      expect(boxTracesWarning(root, runtime)).toBeUndefined();
    },
  );

  test.each([
    ["a plain container image", PLAIN_DOCKERFILE, {}],
    ["a plain CodeZip entry point", PLAIN_DOCKERFILE, { build: "CodeZip", entrypoint: "main.py" }],
  ] as const)(
    "does not warn for %s, which sends its own traces",
    async (_, dockerfile, changes) => {
      const { root, runtime } = await runtimeOf(dockerfile, changes);
      expect(boxTracesWarning(root, runtime)).toBeUndefined();
    },
  );
});

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
