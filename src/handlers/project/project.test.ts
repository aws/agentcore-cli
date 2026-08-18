import { afterEach, test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { DeserializationError, InputValidationError } from "../../errors";
import { FsReadWriteJson, type ReadWriteJson } from "../../io";
import { MEMORY_DESCRIPTION_MAX_LENGTH } from "../../projectSchemas/memory";

async function run(args: string[], opts?: { core?: TestCoreClient }) {
  const io = testIO();
  const core = opts?.core ?? new TestCoreClient();
  const root = createRootHandler(core, {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", "project", ...args]);
  return { io, core };
}

describe.each(["deploy", "status"])("project %s", (command) => {
  test("throws because it is not implemented yet", async () => {
    await expect(run([command])).rejects.toThrow(/not implemented/);
  });
});

test("project dev requires an AgentCore project", async () => {
  await inTempDirectory();
  await expect(run(["dev"])).rejects.toThrow(/No AgentCore project found/);
});

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-project-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  // cwd is the realpath (macOS tmpdir lives behind a /var -> /private/var
  // symlink), matching the paths the manager derives from process.cwd().
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** Scaffolds a project and cds into it so withProject resolves it. */
async function inProject(name = "TestProject"): Promise<string> {
  const directory = await inTempDirectory();
  await run(["create", "--name", name, "--skip-install", "--skip-git"]);
  const projectRoot = join(directory, name);
  process.chdir(projectRoot);
  return projectRoot;
}

describe("project create", () => {
  test("scaffolds the project into a fresh directory named for the project", async () => {
    const directory = await inTempDirectory();
    await run(["create", "--name", "MyAgent"]);

    // One existence check proves the handler→manager pipe; the full manifest
    // is covered by the FsProjectManager snapshot test.
    const projectRoot = join(directory, "MyAgent");
    expect(await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).exists()).toBe(true);
  });

  test("rejects an invalid --project-name", async () => {
    await inTempDirectory();
    await expect(run(["create", "--name", "1-bad"])).rejects.toThrow();
  });

  test("rejects a reserved --project-name", async () => {
    await inTempDirectory();
    await expect(run(["create", "--name", "test"])).rejects.toThrow(/conflicts with/);
  });

  test("runs the post-scaffold steps and reports progress on stderr", async () => {
    const directory = await inTempDirectory();
    const { io, core } = await run(["create", "--name", "MyAgent"]);

    const projectRoot = join(directory, "MyAgent");
    expect(core.projectCommands).toEqual([
      { command: ["npm", "install"], cwd: join(projectRoot, "agentcore", "cdk") },
      { command: ["uv", "sync"], cwd: join(projectRoot, "app", "hello-world") },
      { command: ["git", "init"], cwd: projectRoot },
    ]);
    expect(io.stderr()).toContain("Creating project tree");
    expect(io.stderr()).toContain("Installing CDK dependencies with npm");
    expect(io.stderr()).toContain("Syncing Python dependencies with uv");
    expect(io.stderr()).toContain("Initializing git repository");
    expect(io.stderr()).toContain("Created project 'MyAgent' in ./MyAgent");
  });

  test("--skip-install and --skip-git run no commands", async () => {
    await inTempDirectory();
    const { core } = await run(["create", "--name", "MyAgent", "--skip-install", "--skip-git"]);

    expect(core.projectCommands).toEqual([]);
  });

  test("rejects an unknown --template value", async () => {
    await inTempDirectory();
    await expect(run(["create", "--name", "MyAgent", "--template", "nonsense"])).rejects.toThrow();
  });
});

describe("project add config-bundle", () => {
  const components = {
    "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/orders-agent": {
      configuration: {
        systemPrompt: "Help customers with their orders.",
        temperature: 0.2,
      },
    },
  };

  test("adds a configuration bundle to agentcore.json", async () => {
    const projectRoot = await inProject();
    const { io } = await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      JSON.stringify(components),
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.configBundles).toEqual([
      {
        name: "OrdersConfig",
        type: "ConfigurationBundle",
        components,
        branchName: "mainline",
      },
    ]);
    expect(io.stderr()).toContain("added configuration bundle 'OrdersConfig' to 'TestProject'");
  });

  test("stores optional configuration bundle fields", async () => {
    const projectRoot = await inProject();
    const kmsKeyArn = "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012";

    await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--description",
      "Configuration for the order support runtime",
      "--components",
      JSON.stringify(components),
      "--branch-name",
      "production",
      "--commit-message",
      "Add the initial order support configuration",
      "--kms-key-arn",
      kmsKeyArn,
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.configBundles[0]).toEqual({
      name: "OrdersConfig",
      type: "ConfigurationBundle",
      description: "Configuration for the order support runtime",
      components,
      branchName: "production",
      commitMessage: "Add the initial order support configuration",
      kmsKeyArn,
    });
  });

  test("reads components from a file", async () => {
    const projectRoot = await inProject();
    const componentsPath = join(projectRoot, "components.json");
    await Bun.write(componentsPath, JSON.stringify(components));

    await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      `file://${componentsPath}`,
    ]);

    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(spec.configBundles[0].components).toEqual(components);
  });

  test("adds no files under app", async () => {
    const projectRoot = await inProject();

    await run([
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      JSON.stringify(components),
    ]);

    expect(existsSync(join(projectRoot, "app", "OrdersConfig"))).toBe(false);
  });

  test("rejects a duplicate configuration bundle name", async () => {
    await inProject();
    const args = [
      "add",
      "config-bundle",
      "--name",
      "OrdersConfig",
      "--components",
      JSON.stringify(components),
    ];

    await run(args);
    await expect(run(args)).rejects.toBeInstanceOf(InputValidationError);
  });

  test.each([
    ["missing name", ["--components", JSON.stringify(components)]],
    ["missing components", ["--name", "OrdersConfig"]],
    ["invalid name", ["--name", "orders-config", "--components", JSON.stringify(components)]],
    ["empty components", ["--name", "OrdersConfig", "--components", "{}"]],
    [
      "component without configuration",
      ["--name", "OrdersConfig", "--components", '{"arn:component":{}}'],
    ],
    [
      "non-object component configuration",
      [
        "--name",
        "OrdersConfig",
        "--components",
        '{"arn:component":{"configuration":"not-an-object"}}',
      ],
    ],
    [
      "unexpected component field",
      [
        "--name",
        "OrdersConfig",
        "--components",
        '{"arn:component":{"configuration":{},"unexpected":true}}',
      ],
    ],
    ["malformed components", ["--name", "OrdersConfig", "--components", "{not-json"]],
    [
      "empty description",
      ["--name", "OrdersConfig", "--description", "", "--components", JSON.stringify(components)],
    ],
    [
      "branch name above maximum length",
      [
        "--name",
        "OrdersConfig",
        "--components",
        JSON.stringify(components),
        "--branch-name",
        "b".repeat(129),
      ],
    ],
    [
      "commit message above maximum length",
      [
        "--name",
        "OrdersConfig",
        "--components",
        JSON.stringify(components),
        "--commit-message",
        "m".repeat(501),
      ],
    ],
    [
      "invalid KMS key ARN",
      [
        "--name",
        "OrdersConfig",
        "--components",
        JSON.stringify(components),
        "--kms-key-arn",
        "not-an-arn",
      ],
    ],
  ])("rejects %s", async (_label, flags) => {
    await inProject();
    await expect(run(["add", "config-bundle", ...flags])).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });
});

describe("project add memory", () => {
  /** Verify the flag -> agentcore.json memories[] entry for each flag. */
  test.each<[string, string[], Record<string, unknown>]>([
    [
      "minimal — name only",
      ["--name", "x"],
      { name: "x", eventExpiryDuration: 30, strategies: [] },
    ],
    [
      "description",
      ["--name", "x", "--description", "Durable facts and preferences for each end user."],
      { description: "Durable facts and preferences for each end user." },
    ],
    [
      "description — at the maximum length",
      ["--name", "x", "--description", "a".repeat(MEMORY_DESCRIPTION_MAX_LENGTH)],
      { description: "a".repeat(MEMORY_DESCRIPTION_MAX_LENGTH) },
    ],
    [
      "event-expiry-duration",
      ["--name", "x", "--event-expiry-duration", "7"],
      { eventExpiryDuration: 7 },
    ],
    [
      "strategies — shorthand, one type",
      ["--name", "x", "--strategies", "SEMANTIC"],
      { strategies: [{ type: "SEMANTIC", namespaceTemplates: ["/users/{actorId}/facts"] }] },
    ],
    [
      "strategies — shorthand, several types with surrounding whitespace",
      ["--name", "x", "--strategies", "SEMANTIC, SUMMARIZATION ,USER_PREFERENCE"],
      {
        strategies: [
          { type: "SEMANTIC", namespaceTemplates: ["/users/{actorId}/facts"] },
          { type: "SUMMARIZATION", namespaceTemplates: ["/summaries/{actorId}/{sessionId}"] },
          { type: "USER_PREFERENCE", namespaceTemplates: ["/users/{actorId}/preferences"] },
        ],
      },
    ],
    [
      "strategies — shorthand EPISODIC also gets the default reflection namespaces",
      ["--name", "x", "--strategies", "EPISODIC"],
      {
        strategies: [
          {
            type: "EPISODIC",
            namespaceTemplates: ["/episodes/{actorId}/{sessionId}"],
            reflectionNamespaceTemplates: ["/episodes/{actorId}"],
          },
        ],
      },
    ],
    [
      "strategies — JSON semanticMemoryStrategy",
      [
        "--name",
        "x",
        "--strategies",
        '[{"semanticMemoryStrategy":{"name":"facts","description":"durable facts","namespaceTemplates":["/orgs/{actorId}"]}}]',
      ],
      {
        strategies: [
          {
            type: "SEMANTIC",
            name: "facts",
            description: "durable facts",
            namespaceTemplates: ["/orgs/{actorId}"],
          },
        ],
      },
    ],
    [
      "strategies — JSON summaryMemoryStrategy maps to SUMMARIZATION",
      ["--name", "x", "--strategies", '[{"summaryMemoryStrategy":{"name":"summaries"}}]'],
      { strategies: [{ type: "SUMMARIZATION", name: "summaries" }] },
    ],
    [
      "strategies — JSON userPreferenceMemoryStrategy maps to USER_PREFERENCE",
      ["--name", "x", "--strategies", '[{"userPreferenceMemoryStrategy":{"name":"prefs"}}]'],
      { strategies: [{ type: "USER_PREFERENCE", name: "prefs" }] },
    ],
    [
      "strategies — JSON episodicMemoryStrategy hoists reflectionConfiguration",
      [
        "--name",
        "x",
        "--strategies",
        '[{"episodicMemoryStrategy":{"name":"episodes","namespaceTemplates":["/episodes/{actorId}/{sessionId}"],"reflectionConfiguration":{"namespaceTemplates":["/episodes/{actorId}"]}}}]',
      ],
      {
        strategies: [
          {
            type: "EPISODIC",
            name: "episodes",
            namespaceTemplates: ["/episodes/{actorId}/{sessionId}"],
            reflectionNamespaceTemplates: ["/episodes/{actorId}"],
          },
        ],
      },
    ],
    [
      "strategies — JSON deprecated namespaces are preserved",
      ["--name", "x", "--strategies", '[{"semanticMemoryStrategy":{"namespaces":["/legacy"]}}]'],
      { strategies: [{ type: "SEMANTIC", namespaces: ["/legacy"] }] },
    ],
    [
      "indexed-keys",
      [
        "--name",
        "x",
        "--strategies",
        "SEMANTIC",
        "--indexed-keys",
        '[{"key":"tenant","type":"STRING"},{"key":"score","type":"NUMBER"}]',
      ],
      {
        indexedKeys: [
          { key: "tenant", type: "STRING" },
          { key: "score", type: "NUMBER" },
        ],
      },
    ],
    [
      "stream-delivery-resources",
      [
        "--name",
        "x",
        "--stream-delivery-resources",
        '{"resources":[{"kinesis":{"dataStreamArn":"arn:aws:kinesis:us-east-1:123456789012:stream/s","contentConfigurations":[{"type":"MEMORY_RECORDS","level":"FULL_CONTENT"}]}}]}',
      ],
      {
        streamDeliveryResources: {
          resources: [
            {
              kinesis: {
                dataStreamArn: "arn:aws:kinesis:us-east-1:123456789012:stream/s",
                contentConfigurations: [{ type: "MEMORY_RECORDS", level: "FULL_CONTENT" }],
              },
            },
          ],
        },
      },
    ],
    [
      "encryption-key-arn and execution-role-arn",
      [
        "--name",
        "x",
        "--encryption-key-arn",
        "arn:aws:kms:us-east-1:123456789012:key/abc",
        "--execution-role-arn",
        "arn:aws:iam::123456789012:role/MyMemoryRole",
      ],
      {
        encryptionKeyArn: "arn:aws:kms:us-east-1:123456789012:key/abc",
        executionRoleArn: "arn:aws:iam::123456789012:role/MyMemoryRole",
      },
    ],
    ["tags", ["--name", "x", "--tags", '{"team":"ml"}'], { tags: { team: "ml" } }],
  ])("%s", async (_label, flags, expected) => {
    const projectRoot = await inProject();
    await run(["add", "memory", ...flags]);

    const agentcoreJson = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect(agentcoreJson.memories).toHaveLength(1);
    expect(agentcoreJson.memories[0]).toMatchObject(expected);
  });

  test("adds no files under app/", async () => {
    const projectRoot = await inProject();
    await run(["add", "memory", "--name", "x"]);

    expect(existsSync(join(projectRoot, "app", "x"))).toBe(false);
  });

  test("rejects a duplicate memory name", async () => {
    await inProject();
    await run(["add", "memory", "--name", "x"]);
    await expect(run(["add", "memory", "--name", "x"])).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });

  test.each([
    ["missing --name", ["--event-expiry-duration", "30"]],
    ["invalid name", ["--name", "1bad"]],
    ["empty description", ["--name", "x", "--description", ""]],
    [
      "description above the maximum length",
      ["--name", "x", "--description", "a".repeat(MEMORY_DESCRIPTION_MAX_LENGTH + 1)],
    ],
    ["event-expiry-duration below the minimum", ["--name", "x", "--event-expiry-duration", "2"]],
    ["event-expiry-duration above the maximum", ["--name", "x", "--event-expiry-duration", "400"]],
    ["unrecognized shorthand strategy", ["--name", "x", "--strategies", "NONSENSE"]],
    ["duplicate shorthand strategy", ["--name", "x", "--strategies", "SEMANTIC,SEMANTIC"]],
    ["unrecognized JSON strategy variant", ["--name", "x", "--strategies", '[{"unknown":{}}]']],
    // CUSTOM is rejected in both forms until a custom strategy's extraction
    // configuration can be expressed. See aws/agentcore-cli#241, #266, #713, #676.
    ["CUSTOM shorthand strategy", ["--name", "x", "--strategies", "CUSTOM"]],
    [
      "customMemoryStrategy JSON variant",
      ["--name", "x", "--strategies", '[{"customMemoryStrategy":{"name":"c"}}]'],
    ],
    [
      "episodic strategy without reflection namespaces",
      ["--name", "x", "--strategies", '[{"episodicMemoryStrategy":{"name":"episodes"}}]'],
    ],
    [
      "namespaces and namespaceTemplates are mutually exclusive",
      [
        "--name",
        "x",
        "--strategies",
        '[{"semanticMemoryStrategy":{"namespaces":["/a"],"namespaceTemplates":["/b"]}}]',
      ],
    ],
    [
      "indexed-keys without a strategy",
      ["--name", "x", "--indexed-keys", '[{"key":"tenant","type":"STRING"}]'],
    ],
    [
      "indexed-keys with an unsupported type",
      [
        "--name",
        "x",
        "--strategies",
        "SEMANTIC",
        "--indexed-keys",
        '[{"key":"tenant","type":"BOOLEAN"}]',
      ],
    ],
    [
      "indexed-keys without a key",
      ["--name", "x", "--strategies", "SEMANTIC", "--indexed-keys", '[{"type":"STRING"}]'],
    ],
    [
      "unrecognized stream delivery resource variant",
      ["--name", "x", "--stream-delivery-resources", '{"resources":[{"firehose":{}}]}'],
    ],
    [
      "stream delivery resource without a dataStreamArn",
      [
        "--name",
        "x",
        "--stream-delivery-resources",
        '{"resources":[{"kinesis":{"contentConfigurations":[{"type":"MEMORY_RECORDS","level":"FULL_CONTENT"}]}}]}',
      ],
    ],
    [
      "stream delivery content configuration without a level",
      [
        "--name",
        "x",
        "--stream-delivery-resources",
        '{"resources":[{"kinesis":{"dataStreamArn":"arn:aws:kinesis:us-east-1:123456789012:stream/s","contentConfigurations":[{"type":"MEMORY_RECORDS"}]}}]}',
      ],
    ],
    ["malformed --strategies JSON", ["--name", "x", "--strategies", "[{"]],
  ])("%s", async (_label, flags) => {
    await inProject();
    await expect(run(["add", "memory", ...flags])).rejects.toBeInstanceOf(InputValidationError);
  });
});

describe("project build", () => {
  async function inBuildableProject(): Promise<string> {
    const projectRoot = await inProject("MyAgent");
    // create --skip-install leaves no node_modules, which build requires.
    await mkdir(join(projectRoot, "agentcore", "cdk", "node_modules"), { recursive: true });
    return projectRoot;
  }

  test("synthesizes the CDK app of the enclosing project", async () => {
    const projectRoot = await inBuildableProject();
    const { io, core } = await run(["build"]);

    expect(core.projectCommands).toEqual([
      {
        command: ["npm", "run", "cdk", "--", "synth", "--quiet"],
        cwd: join(projectRoot, "agentcore", "cdk"),
      },
    ]);
    expect(io.stderr()).toContain("Synthesizing CloudFormation templates");
    expect(io.stderr()).toContain("Built project 'MyAgent'");
  });

  test("resolves the project from a nested directory", async () => {
    const projectRoot = await inBuildableProject();
    process.chdir(join(projectRoot, "app", "hello-world"));

    const { core } = await run(["build"]);

    expect(core.projectCommands.map(({ cwd }) => cwd)).toEqual([
      join(projectRoot, "agentcore", "cdk"),
    ]);
  });

  test("fails with actionable guidance outside a project", async () => {
    await inTempDirectory();
    await expect(run(["build"])).rejects.toThrow(/No AgentCore project found/);
  });

  test("fails when the CDK dependencies have not been installed", async () => {
    const projectRoot = await inBuildableProject();
    await rm(join(projectRoot, "agentcore", "cdk", "node_modules"), { recursive: true });

    await expect(run(["build"])).rejects.toThrow(/npm install/);
  });
});
