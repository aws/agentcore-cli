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
import { AWS_CLI_RELEASE, awsCliWarnings, stageBoxContainers } from "./boxContainer";
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
      agentCoreGateways: [boxGatewaySpec("agent", "strands-box")],
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

    expect(await stageBoxContainers(demo, [model([])])).toEqual(["agent"]);

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
    expect(await readFile(join(dist, PACK_PATH), "utf8")).toBe(
      renderAgentCorePack(demo.spec, demo.spec.runtimes[0]!),
    );
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

    await stageBoxContainers(demo, [model([])]);

    expect((await readdir(dist)).sort()).toEqual([...STAGED, "resources"].sort());
  });

  test("stages nothing for a user's image that copies .box-dist/ but has no box.version", async () => {
    const demo = await project(BOX_DOCKERFILE);
    delete demo.spec.runtimes[0]!.box;

    expect(await stageBoxContainers(demo, [model([])])).toEqual([]);
  });

  test("stages nothing for a runtime with no box.version", async () => {
    const demo = await project("FROM scratch\n");

    expect(await stageBoxContainers(demo, [model([])])).toEqual([]);
    expect(existsSync(join(demo.rootPath, "app", "agent", ".box-dist"))).toBe(false);
  });

  test("copies each policy file of the model beside the profile, for an image that copies .box-dist/ whole", async () => {
    const demo = await project(TEMPLATE_DOCKERFILE);
    await mkdir(join(demo.rootPath, ".box", "agent", "local"), { recursive: true });
    await writeFile(join(demo.rootPath, ".box", "agent", "local", "policy.dw"), "// rules\n");

    await stageBoxContainers(demo, [model(["policy.dw"])]);

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

    await stageBoxContainers(demo, [{ ...model([]), thirdPartyTelemetry: [langsmith] }]);
    expect(await env()).toEndWith(
      `AWS_CLI_URL=${AWS_CLI_RELEASE.url}\nAWS_CLI_SHA256=${AWS_CLI_RELEASE.sha256}\n`,
    );

    for (const networks of [
      [model([])],
      [{ ...model([]), thirdPartyTelemetry: [open] }],
    ] as BoxNetwork[][]) {
      await stageBoxContainers(demo, networks);
      expect(await env()).not.toContain("AWS_CLI");
    }
  });

  test("the image installs the AWS CLI it is told to, checks its SHA-256 before it unzips, and keeps it out of /app", () => {
    // Read from box-release.env, which the CLI writes only with the switch on.
    expect(TEMPLATE_DOCKERFILE).toContain('if [ -n "${AWS_CLI_URL:-}" ]; then');
    const check = TEMPLATE_DOCKERFILE.indexOf(
      'echo "${AWS_CLI_SHA256}  /tmp/awscli.zip" | sha256sum -c -',
    );
    expect(check).toBeGreaterThan(
      TEMPLATE_DOCKERFILE.indexOf('-o /tmp/awscli.zip "${AWS_CLI_URL}"'),
    );
    expect(check).toBeLessThan(TEMPLATE_DOCKERFILE.indexOf("unzip -q /tmp/awscli.zip"));
    expect(TEMPLATE_DOCKERFILE).toContain(
      "--install-dir /usr/local/aws-cli --bin-dir /usr/local/bin",
    );
    expect(TEMPLATE_DOCKERFILE).not.toMatch(/gpg|PGP|\.sig\b/);
    expect(AWS_CLI_RELEASE.url).toBe(
      `https://awscli.amazonaws.com/awscli-exe-linux-aarch64-${AWS_CLI_RELEASE.version}.zip`,
    );
    expect(AWS_CLI_RELEASE.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("refuses an image that copies only the profile when policy files go with it", async () => {
    const demo = await project(BOX_DOCKERFILE);
    await mkdir(join(demo.rootPath, ".box", "agent", "local"), { recursive: true });
    await writeFile(join(demo.rootPath, ".box", "agent", "local", "policy.dw"), "// rules\n");

    await expect(stageBoxContainers(demo, [model(["policy.dw"])])).rejects.toThrow(
      "does not copy .box-dist/ whole into the image",
    );
    expect(existsSync(join(demo.rootPath, "app", "agent", ".box-dist"))).toBe(false);
  });
});

describe("awsCliWarnings", () => {
  const langfuse = {
    name: "langfuse",
    kind: "langfuse",
    keys: [],
    secret: { variable: "LANGFUSE_AUTH", keys: [] },
  } as const;
  const open = {
    name: "open",
    kind: "otlp",
    keys: [["destination", "https://o.example"]],
  } as const;
  const reading = (): BoxNetwork[] => [{ ...model([]), thirdPartyTelemetry: [langfuse] }];
  const WARNING =
    "Runtime 'agent' reads the key of [telemetry.langfuse] from AWS Secrets Manager on " +
    "AgentCore Runtime. Box reads that key with the AWS CLI (aws), which app/agent/Dockerfile " +
    "does not install. Thus box cannot read the key, and it does not start the agent. Add the " +
    "AWS CLI lines (the lines that read AWS_CLI_URL) of the agent-python-strands-box " +
    "Dockerfile.template of this CLI to that Dockerfile. Or replace the runtime with a new " +
    "runtime from the template of this CLI.";

  test("warns for a Dockerfile from an older template, which does not install the AWS CLI", async () => {
    expect(awsCliWarnings(await project(BOX_DOCKERFILE), reading())).toEqual([WARNING]);
  });

  test("warns when only a comment names AWS_CLI_URL", async () => {
    const demo = await project(`${BOX_DOCKERFILE}# AWS_CLI_URL is not read here\n`);

    expect(awsCliWarnings(demo, reading())).toEqual([WARNING]);
  });

  test("does not warn for the Dockerfile of the current template", async () => {
    expect(awsCliWarnings(await project(TEMPLATE_DOCKERFILE), reading())).toEqual([]);
  });

  test("does not warn when no target of the Runtime profile has a key", async () => {
    const demo = await project(BOX_DOCKERFILE);

    for (const networks of [[model([])], [{ ...model([]), thirdPartyTelemetry: [open] }]]) {
      expect(awsCliWarnings(demo, networks as BoxNetwork[])).toEqual([]);
    }
  });

  test("does not warn for a runtime that is not a box container", async () => {
    const codeZip = await project(BOX_DOCKERFILE);
    codeZip.spec.runtimes[0]!.build = "CodeZip";
    const unboxed = await project(BOX_DOCKERFILE);
    delete unboxed.spec.runtimes[0]!.box;

    expect(awsCliWarnings(codeZip, reading())).toEqual([]);
    expect(awsCliWarnings(unboxed, reading())).toEqual([]);
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
    managedTargets: new Set<string>(),
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
