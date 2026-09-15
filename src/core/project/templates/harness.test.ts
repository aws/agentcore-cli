import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type z from "zod";
import { HarnessSpecSchema } from "../../../projectSchemas/harness";
import { HarnessConfigReader } from "../../../io/harnessConfig";
import { getHarnessTemplateResolver } from "./harness";

const roots: string[] = [];
const model = { provider: "bedrock", modelId: "example" } as const;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scaffold(overrides: Partial<z.input<typeof HarnessSpecSchema>> = {}) {
  const root = await mkdtemp(join(tmpdir(), "harness-yaml-template-"));
  roots.push(root);
  const { tree } = await getHarnessTemplateResolver().resolve({
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
  const { directory, path, yaml, data } = await scaffold();
  expect((await readdir(directory)).sort()).toEqual(["harness.yaml", "system-prompt.md"]);
  expect(data).toEqual({
    name: "assistant",
    model,
    systemPrompt: "file://./system-prompt.md",
    memory: { mode: "managed" },
  });
  expect(yaml).toMatch(/^# maxTokens:/m);
  expect(yaml).toContain("agentcore_code_interpreter");
  expect(yaml).toContain("remote_mcp");
  expect(yaml).toMatch(/^# https:\/\/docs\.aws\.amazon\.com\//m);
  expect(HarnessSpecSchema.parse(await new HarnessConfigReader().read(path)).systemPrompt).toBe(
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
  const { data } = await scaffold({ memory });
  expect(data.memory).toEqual(memory);
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
    environmentVariables: { YES: "true", NUMBER: "007", NULL: "null", OTHER: "a: b\nc" },
    tags: { team: "false" },
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
  const { data, path } = await scaffold(overrides);
  const expected = HarnessSpecSchema.parse({
    name: "assistant",
    model,
    ...overrides,
    memory: { mode: "managed" },
  });
  expect(data).toEqual({ ...expected, systemPrompt: "file://./system-prompt.md" });
  expect(HarnessSpecSchema.parse(await new HarnessConfigReader().read(path))).toEqual(expected);
});

test("preserves a supplied explicit prompt reference", async () => {
  const { data, directory } = await scaffold({ systemPrompt: "file://../shared.md" });
  expect(data.systemPrompt).toBe("file://../shared.md");
  expect(await readFile(join(directory, "system-prompt.md"), "utf8")).not.toContain("file://");
});

test("defaults only absent memory and does not mask an invalid supplied setting", async () => {
  await expect(scaffold({ memory: null })).rejects.toThrow();
});

test.each(["file://", "", " \n"])(
  "shared project scaffolding rejects invalid authoring prompt %j",
  async (systemPrompt) => {
    await expect(scaffold({ systemPrompt })).rejects.toThrow();
  },
);
