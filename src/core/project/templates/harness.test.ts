import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type z from "zod";
import { HarnessSpecSchema, HarnessYamlSchema } from "../../../projectSchemas/harness";
import { FsAssetSource } from "../source";
import { getHarnessTemplateResolver } from "./harness";
import { HandlebarsTemplateRenderer } from "./renderer";

const roots: string[] = [];
const model = {
  provider: "bedrock",
  modelId: "global.anthropic.claude-sonnet-4-6",
} as const;
const defaultSettings = {
  memory: { mode: "managed" },
  allowedTools: ["*"],
  skills: [],
  truncation: { strategy: "sliding_window" },
  environmentVariables: {},
  networkMode: "PUBLIC",
  authorizerType: "AWS_IAM",
  tags: {},
};
const config = {
  assetSource: new FsAssetSource(),
  templateRenderer: new HandlebarsTemplateRenderer(),
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scaffold(overrides: Partial<z.input<typeof HarnessSpecSchema>> = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-yaml-template-"));
  roots.push(root);
  const { tree } = await getHarnessTemplateResolver(config).resolve({
    name: "assistant",
    model,
    ...overrides,
  });
  await tree.write(root);
  const directory = join(root, "assistant");
  const path = join(directory, "harness.yaml");
  const yaml = await readFile(path, "utf8");
  return { directory, path, yaml, data: parse(yaml) };
}

test("scaffolds valid YAML with inactive examples and a resolvable prompt", async () => {
  const { directory, yaml, data } = await scaffold();
  expect((await readdir(directory)).sort()).toEqual(["harness.yaml", "system-prompt.md"]);
  expect(data).toEqual({
    name: "assistant",
    model: { bedrockModelConfig: { modelId: model.modelId } },
    memory: { managedMemoryConfiguration: {} },
    tools: [],
    allowedTools: ["*"],
    skills: [],
    truncation: { strategy: "sliding_window" },
    environmentVariables: {},
    tags: {},
  });
  expect(yaml).toMatchSnapshot();
  expect(await readFile(join(directory, "system-prompt.md"), "utf8")).toBe(
    "You are a helpful assistant",
  );
});

test.each([
  { mode: "disabled" },
  {
    mode: "existing",
    name: "ConversationMemory",
    actorId: "007",
    retrievalConfig: { relevanceScore: 0 },
  },
  {
    mode: "existing",
    arn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/example-1234567890",
  },
  { mode: "managed", strategies: ["EPISODIC"], eventExpiryDuration: 365 },
] as const)("preserves explicit memory: %j", async (memory) => {
  const { data, yaml } = await scaffold({ memory });
  expect<unknown>(HarnessYamlSchema.parse(data).memory).toEqual(memory);
  if (memory.mode !== "managed") {
    expect(yaml).not.toContain("# Managed memory is created for this harness.");
    expect(yaml).not.toContain("# strategies:");
    expect(yaml).not.toContain("# eventExpiryDuration:");
  }
});

test("serializes supplied nested strings, arrays, maps, and zero values without example substitution", async () => {
  const overrides: Partial<z.input<typeof HarnessSpecSchema>> = {
    model: {
      provider: "lite_llm",
      modelId: "true",
      temperature: 0,
      topP: 0,
      maxTokens: 27,
      additionalParams: {
        quoted: 'a: "b" # comment\nnext',
        template: "{{name}} {{#if tools}}not expanded{{/if}}",
        flags: [false, 0, "007", "null"],
        nested: { "a: b": "[x]" },
      },
    },
    systemPrompt: "  Exact prompt.\r\nWith whitespace.\n",
    tools: [
      {
        name: "custom",
        type: "remote_mcp",
        config: {
          remoteMcp: {
            url: "https://example.com/a?x=#y",
            headers: { Authorization: 'Bearer "secret": # not a comment' },
          },
        },
      },
    ],
    allowedTools: ["@custom/search"],
    skills: [{ path: "/opt/runtime-only" }],
    environmentVariables: {
      YES: "true",
      NUMBER: "007",
      NULL: "null",
      OTHER: "a: b\nc",
      EMPTY: "",
      TRAILING: "line\n\n",
    },
    tags: { team: "false" },
    networkMode: "PUBLIC",
    truncation: {
      strategy: "summarization",
      config: {
        summarization: {
          summaryRatio: 0,
          preserveRecentMessages: 0,
          summarizationSystemPrompt: "inline: # summary\n",
        },
      },
    },
    maxIterations: 2,
    timeoutSeconds: 19,
  };
  const { data, directory } = await scaffold(overrides);
  const { systemPrompt, ...expected } = HarnessSpecSchema.parse({
    ...defaultSettings,
    name: "assistant",
    model,
    ...overrides,
  });
  expect(HarnessYamlSchema.parse(data)).toEqual(expected);
  expect(await readFile(join(directory, "system-prompt.md"), "utf8")).toBe(systemPrompt!);
});

test("renders supplied deployment settings once in their sections", async () => {
  const overrides: Partial<z.input<typeof HarnessSpecSchema>> = {
    networkMode: "VPC",
    networkConfig: {
      vpcId: "vpc-0123456789abcdef0",
      subnets: ["subnet-0123456789abcdef0"],
      securityGroups: ["sg-0123456789abcdef0"],
    },
    authorizerType: "CUSTOM_JWT",
    authorizerConfiguration: {
      customJwtAuthorizer: {
        discoveryUrl: "https://example.com/.well-known/openid-configuration",
        allowedAudience: ["assistant"],
      },
    },
    lifecycleConfig: { idleRuntimeSessionTimeout: 300, maxLifetime: 3600 },
    sessionStoragePath: "/mnt/session",
    efsAccessPoints: [
      {
        accessPointArn:
          "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0",
        mountPath: "/mnt/efs",
      },
    ],
    s3AccessPoints: [
      {
        accessPointArn:
          "arn:aws:s3files:us-east-1:123456789012:file-system/fs-0123456789abcdef0/access-point/fsap-0123456789abcdef0",
        mountPath: "/mnt/s3",
      },
    ],
    connections: [
      {
        to: {
          type: "memory",
          arn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/existing-1234567890",
        },
        access: "read",
      },
    ],
  };
  const { data } = await scaffold(overrides);
  expect(data.environment).toEqual({
    agentCoreRuntimeEnvironment: {
      networkConfiguration: {
        networkMode: "VPC",
        networkModeConfig: {
          subnets: overrides.networkConfig!.subnets,
          securityGroups: overrides.networkConfig!.securityGroups,
        },
      },
      lifecycleConfiguration: overrides.lifecycleConfig,
      filesystemConfigurations: [
        { sessionStorage: { mountPath: overrides.sessionStoragePath } },
        { efsAccessPoint: overrides.efsAccessPoints![0] },
        { s3FilesAccessPoint: overrides.s3AccessPoints![0] },
      ],
    },
  });
  expect(data.networkConfig).toEqual({ vpcId: overrides.networkConfig!.vpcId });
  expect<unknown>(HarnessYamlSchema.parse(data)).toEqual({
    name: "assistant",
    model,
    tools: [],
    ...defaultSettings,
    ...overrides,
  });
});

test("preserves explicit empty settings and disabled truncation", async () => {
  const { data, yaml } = await scaffold({
    allowedTools: [],
    truncation: { strategy: "none" },
    model: { ...model, temperature: 0, topP: 0, maxTokens: 123, apiFormat: "responses" },
  });
  expect(data.allowedTools).toEqual([]);
  expect(data.truncation).toEqual({ strategy: "none" });
  expect(yaml).not.toContain("#     messagesCount: 40");
  expect(yaml).not.toContain("# temperature:");
  expect(yaml).not.toContain("# topP:");
  expect(yaml).not.toContain("# maxTokens: 4096");
  expect(yaml).not.toContain("# apiFormat:");
});

test.each([
  ["bedrock", "converse_stream", "bedrockModelConfig"],
  ["open_ai", "responses", "openAiModelConfig"],
  ["gemini", undefined, "geminiModelConfig"],
  ["lite_llm", undefined, "liteLlmModelConfig"],
] as const)("shows compatible model examples for %s", async (provider, apiFormat, key) => {
  const { yaml } = await scaffold({
    model: { provider, modelId: "example", apiKeyArn: "arn:example" },
  });
  if (apiFormat) expect(yaml).toContain(`# apiFormat: ${apiFormat}`);
  else expect(yaml).not.toContain("# apiFormat:");
  expect(yaml).toContain(`  ${key}:`);
});

test("keeps the sliding-window size optional", async () => {
  const { data, yaml } = await scaffold({ truncation: { strategy: "sliding_window" } });
  expect(data.truncation).toEqual({ strategy: "sliding_window" });
  expect(yaml).toContain("  #     messagesCount: 40");
});

test("writes supplied instructions to the conventional prompt file", async () => {
  const systemPrompt = "\uFEFFBe concise.\r\n";
  const { data, directory } = await scaffold({ systemPrompt });
  expect(data.systemPrompt).toBeUndefined();
  expect(await readFile(join(directory, "system-prompt.md"), "utf8")).toBe(systemPrompt);
});

test("defaults only absent memory and does not mask an invalid supplied setting", async () => {
  await expect(scaffold({ memory: null })).rejects.toThrow();
});

test.each(["", " \n"])(
  "shared project scaffolding rejects blank prompt %j",
  async (systemPrompt) => {
    await expect(scaffold({ systemPrompt })).rejects.toThrow();
  },
);
