import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBoxGatewayBedrockEntry } from "../../../handlers/project/box-gateway-test-support";
import type { Project } from "../../../handlers/project/types";
import type { BoxNetwork } from "../boxNetwork";
import { renderAgentCorePack, renderRuntimeBoxProfile } from "../templates/boxProfile";
import { AWS_CLI_RELEASE, stageBoxContainers } from "./boxContainer";
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
    await mkdir(join(demo.rootPath, ".box", "agent", "local"), { recursive: true });
    await writeFile(join(demo.rootPath, ".box", "agent", "local", "policy.dw"), "// rules\n");

    await stageBoxContainers(demo, [model(["policy.dw"])], releaseOf().releaseFor);

    const dist = join(demo.rootPath, "app", "agent", ".box-dist");
    expect((await readdir(dist)).sort()).toEqual(["policy.dw", ...STAGED, "resources"].sort());
    expect(await readFile(join(dist, "policy.dw"), "utf8")).toBe("// rules\n");
  });

  test("names the AWS CLI for the image only when the Runtime profile reads a key from Secrets Manager", async () => {
    const demo = await project(TEMPLATE_DOCKERFILE);
    const env = () =>
      readFile(join(demo.rootPath, "app", "agent", ".box-dist", "box-release.env"), "utf8");
    const langsmith = {
      name: "langsmith",
      kind: "langsmith",
      keys: [],
      secret: { variable: "LANGSMITH_KEY", keys: [] },
    } as const;
    const open = {
      name: "open",
      kind: "otlp",
      keys: [["destination", "https://o.example"]],
    } as const;

    await stageBoxContainers(
      demo,
      [{ ...model([]), thirdPartyTelemetry: [langsmith] }],
      releaseOf().releaseFor,
    );
    expect(await env()).toEndWith(
      `AWS_CLI_URL=${AWS_CLI_RELEASE.url}\nAWS_CLI_SHA256=${AWS_CLI_RELEASE.sha256}\n`,
    );

    for (const networks of [
      [],
      [{ ...model([]), thirdPartyTelemetry: [open] }],
    ] as BoxNetwork[][]) {
      await stageBoxContainers(demo, networks, releaseOf().releaseFor);
      expect(await env()).not.toContain("AWS_CLI");
    }
  });

  test("the image installs the AWS CLI it is told to, checks its archive, and keeps it out of /app", () => {
    // Read from box-release.env, which the CLI writes only with the switch on.
    expect(TEMPLATE_DOCKERFILE).toContain('if [ -n "${AWS_CLI_URL:-}" ]; then');
    expect(TEMPLATE_DOCKERFILE).toContain(
      'echo "${AWS_CLI_SHA256}  /tmp/awscli.zip" | sha256sum -c -',
    );
    expect(TEMPLATE_DOCKERFILE).toContain(
      "--install-dir /usr/local/aws-cli --bin-dir /usr/local/bin",
    );
    expect(AWS_CLI_RELEASE.url).toBe(
      `https://awscli.amazonaws.com/awscli-exe-linux-aarch64-${AWS_CLI_RELEASE.version}.zip`,
    );
  });

  test("refuses an image that copies only the profile when policy files go with it", async () => {
    const demo = await project(BOX_DOCKERFILE);
    await mkdir(join(demo.rootPath, ".box", "agent", "local"), { recursive: true });
    await writeFile(join(demo.rootPath, ".box", "agent", "local", "policy.dw"), "// rules\n");

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
