import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../../../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../../testing";
import { InputValidationError } from "../../../../errors";
import { MEMORY_DESCRIPTION_MAX_LENGTH } from "../../../../projectSchemas/memory";

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-memory-"));
  tempDirectories.push(directory);
  // cwd is the realpath (macOS tmpdir lives behind a /var -> /private/var
  // symlink), matching the paths the manager derives from process.cwd().
  process.chdir(directory);
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

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

/** Scaffolds a project and cds into it so withProject resolves it. */
async function inProject(name = "TestProject"): Promise<string> {
  const directory = await inTempDirectory();
  await run(["create", "--name", name, "--skip-install", "--skip-git"]);
  const projectRoot = join(directory, name);
  process.chdir(projectRoot);
  return projectRoot;
}

describe("project add memory", () => {
  test("--json returns a structured project mutation result", async () => {
    const projectRoot = await inProject();
    const { io } = await run(["add", "memory", "--name", "customer_memory", "--json"]);

    expect(JSON.parse(io.stdout())).toEqual({
      operation: "add",
      project: { name: "TestProject", path: projectRoot },
      resource: { type: "memory", name: "customer_memory" },
    });
    expect(io.stderr()).not.toContain("added memory");
  });

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
      "strategies — JSON is stored verbatim",
      [
        "--name",
        "x",
        "--strategies",
        '[{"type":"SEMANTIC","name":"facts","description":"durable facts","namespaceTemplates":["/orgs/{actorId}"]}]',
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
      "strategies — JSON entry without a name, as the schema allows",
      ["--name", "x", "--strategies", '[{"type":"SUMMARIZATION"}]'],
      { strategies: [{ type: "SUMMARIZATION" }] },
    ],
    [
      "strategies — several JSON entries",
      [
        "--name",
        "x",
        "--strategies",
        '[{"type":"SUMMARIZATION","name":"summaries"},{"type":"USER_PREFERENCE","name":"prefs"}]',
      ],
      {
        strategies: [
          { type: "SUMMARIZATION", name: "summaries" },
          { type: "USER_PREFERENCE", name: "prefs" },
        ],
      },
    ],
    [
      "strategies — JSON EPISODIC with reflection namespace templates",
      [
        "--name",
        "x",
        "--strategies",
        '[{"type":"EPISODIC","name":"episodes","namespaceTemplates":["/episodes/{actorId}/{sessionId}"],"reflectionNamespaceTemplates":["/episodes/{actorId}"]}]',
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
      [
        "--name",
        "x",
        "--strategies",
        '[{"type":"SEMANTIC","name":"legacy","namespaces":["/legacy"]}]',
      ],
      { strategies: [{ type: "SEMANTIC", name: "legacy", namespaces: ["/legacy"] }] },
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
    ["empty shorthand strategy entry", ["--name", "x", "--strategies", "SEMANTIC,"]],
    ["duplicate shorthand strategy", ["--name", "x", "--strategies", "SEMANTIC,SEMANTIC"]],
    ["JSON strategy without a type", ["--name", "x", "--strategies", '[{"name":"facts"}]']],
    [
      "JSON strategy with an invalid name",
      ["--name", "x", "--strategies", '[{"type":"SEMANTIC","name":"1bad"}]'],
    ],
    [
      "duplicate JSON strategy type",
      ["--name", "x", "--strategies", '[{"type":"SEMANTIC"},{"type":"SEMANTIC"}]'],
    ],
    [
      "JSON strategy input must be an array",
      ["--name", "x", "--strategies", '{"type":"SEMANTIC","name":"facts"}'],
    ],
    // CUSTOM is rejected in both forms until a custom strategy's extraction
    // configuration can be expressed. See aws/agentcore-cli#241, #266, #713, #676.
    ["CUSTOM shorthand strategy", ["--name", "x", "--strategies", "CUSTOM"]],
    ["CUSTOM JSON strategy", ["--name", "x", "--strategies", '[{"type":"CUSTOM","name":"c"}]']],
    [
      "episodic strategy without reflection namespaces",
      ["--name", "x", "--strategies", '[{"type":"EPISODIC","name":"episodes"}]'],
    ],
    [
      "reflection namespaces on a non-episodic strategy",
      [
        "--name",
        "x",
        "--strategies",
        '[{"type":"SEMANTIC","name":"facts","reflectionNamespaceTemplates":["/a"]}]',
      ],
    ],
    [
      "namespaces and namespaceTemplates are mutually exclusive",
      [
        "--name",
        "x",
        "--strategies",
        '[{"type":"SEMANTIC","name":"facts","namespaces":["/a"],"namespaceTemplates":["/b"]}]',
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
    [
      "stream delivery content configuration with an unsupported type",
      [
        "--name",
        "x",
        "--stream-delivery-resources",
        '{"resources":[{"kinesis":{"dataStreamArn":"arn:aws:kinesis:us-east-1:123456789012:stream/s","contentConfigurations":[{"type":"EVENTS","level":"FULL_CONTENT"}]}}]}',
      ],
    ],
    ["malformed --strategies JSON", ["--name", "x", "--strategies", "[{"]],
  ])("%s", async (_label, flags) => {
    await inProject();
    await expect(run(["add", "memory", ...flags])).rejects.toBeInstanceOf(InputValidationError);
  });

  test.each<[string, string[], RegExp]>([
    [
      "rejects unsupported strategy fields",
      [
        "--name",
        "x",
        "--strategies",
        '[{"type":"SEMANTIC","name":"facts","memoryRecordSchema":{}}]',
      ],
      /memory strategy field 'memoryRecordSchema' is not supported by project memory resources/,
    ],
    // The CreateMemory API nests each strategy under a member key; agentcore.json
    // stores it flat, so the API shape is reported field by field.
    [
      "rejects the CreateMemory MemoryStrategyInput shape",
      ["--name", "x", "--strategies", '[{"semanticMemoryStrategy":{"name":"facts"}}]'],
      /memory strategy field 'semanticMemoryStrategy' is not supported by project memory resources/,
    ],
    [
      "rejects the CreateMemory episodic reflectionConfiguration shape",
      [
        "--name",
        "x",
        "--strategies",
        '[{"type":"EPISODIC","name":"episodes","reflectionConfiguration":{"namespaceTemplates":["/episodes/{actorId}"]}}]',
      ],
      /memory strategy field 'reflectionConfiguration' is not supported by project memory resources/,
    ],
    [
      "rejects prototype-named unsupported strategy fields",
      [
        "--name",
        "x",
        "--strategies",
        '[{"type":"SEMANTIC","name":"facts","__proto__":{"polluted":true}}]',
      ],
      /memory strategy field '__proto__' is not supported by project memory resources/,
    ],
    [
      "validates indexed-keys as an array",
      ["--name", "x", "--indexed-keys", '{"key":"tenant","type":"STRING"}'],
      /Invalid value for option '--indexed-keys'/,
    ],
    [
      "rejects unsupported indexed-key fields",
      [
        "--name",
        "x",
        "--strategies",
        "SEMANTIC",
        "--indexed-keys",
        '[{"key":"tenant","type":"STRING","unexpected":true}]',
      ],
      /indexed key field 'unexpected' is not supported by project memory resources/,
    ],
    [
      "validates stream delivery resources as an array",
      ["--name", "x", "--stream-delivery-resources", '{"resources":{}}'],
      /Invalid value for option '--stream-delivery-resources'/,
    ],
    [
      "rejects unsupported top-level stream delivery fields",
      [
        "--name",
        "x",
        "--stream-delivery-resources",
        '{"resources":[{"kinesis":{"dataStreamArn":"arn:aws:kinesis:us-east-1:123456789012:stream/s","contentConfigurations":[{"type":"MEMORY_RECORDS","level":"FULL_CONTENT"}]}}],"unexpected":true}',
      ],
      /stream delivery resources field 'unexpected' is not supported by project memory resources/,
    ],
    [
      "rejects unsupported stream delivery resource variants",
      [
        "--name",
        "x",
        "--stream-delivery-resources",
        '{"resources":[{"kinesis":{"dataStreamArn":"arn:aws:kinesis:us-east-1:123456789012:stream/s","contentConfigurations":[{"type":"MEMORY_RECORDS","level":"FULL_CONTENT"}]},"firehose":{}}]}',
      ],
      /stream delivery resource field 'firehose' is not supported by project memory resources/,
    ],
    [
      "rejects unsupported Kinesis stream delivery fields",
      [
        "--name",
        "x",
        "--stream-delivery-resources",
        '{"resources":[{"kinesis":{"dataStreamArn":"arn:aws:kinesis:us-east-1:123456789012:stream/s","contentConfigurations":[{"type":"MEMORY_RECORDS","level":"FULL_CONTENT"}],"unexpected":true}}]}',
      ],
      /Kinesis stream delivery resource field 'unexpected' is not supported by project memory resources/,
    ],
    [
      "rejects unsupported nested stream delivery fields",
      [
        "--name",
        "x",
        "--stream-delivery-resources",
        '{"resources":[{"kinesis":{"dataStreamArn":"arn:aws:kinesis:us-east-1:123456789012:stream/s","contentConfigurations":[{"type":"MEMORY_RECORDS","level":"FULL_CONTENT","unexpected":true}]}}]}',
      ],
      /stream content configuration field 'unexpected' is not supported by project memory resources/,
    ],
    [
      "validates tags as a string map",
      ["--name", "x", "--tags", '["team=ml"]'],
      /Invalid value for option '--tags'/,
    ],
  ])("%s", async (_label, flags, error) => {
    await inProject();
    await expect(run(["add", "memory", ...flags])).rejects.toThrow(error);
  });
});
