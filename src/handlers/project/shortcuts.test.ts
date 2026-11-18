import { describe, expect, test } from "bun:test";
import { AgentCoreGatewaySchema } from "../../projectSchemas/gateway";
import {
  EMPTY_TEMPLATE_NAME,
  formatTemplateParameterHelp,
  getBoxGatewayBedrockTargetSpec,
  getDefaultMemorySpec,
  PROJECT_TEMPLATE_NAMES,
  resolveRuntimeTemplateShortcut,
  RUNTIME_TEMPLATE_SHORTCUT_NAMES,
  RUNTIME_TEMPLATE_SHORTCUTS,
} from "./shortcuts";
import { getBoxGatewayBedrockEntry } from "./box-gateway-test-support";

describe("template order", () => {
  test("groups by protocol, then language, framework, and build, with empty last", () => {
    expect(PROJECT_TEMPLATE_NAMES).toEqual([
      "agent-python-strands",
      "agent-python-strands-box",
      "agent-python-strands-container",
      "agent-python-strands-box-container",
      "agent-python-langchain",
      "agent-python-langchain-box",
      "environment-python-bma",
      "agent-python-minimal",
      "agent-python-minimal-box",
      "agent-typescript-strands",
      "agent-typescript-vercel",
      "a2a-python-strands",
      "agui-python-strands",
      "mcp-python-fastmcp",
      "empty",
    ]);
  });
});

test("the Bedrock Managed Agents shortcut selects its environment profile", () => {
  expect(RUNTIME_TEMPLATE_SHORTCUTS["environment-python-bma"]).toMatchObject({
    build: "Container",
    language: "Python",
    framework: "bma",
    protocol: "HTTP",
    includesMemory: false,
    supportsModelProviderOverride: false,
    profile: {
      usesModel: false,
      dependencySetup: "deferred",
      runtime: {
        entrypoint: "lifecycle/server.py",
        dockerfile: "Dockerfile",
        lifecycleConfiguration: {
          idleRuntimeSessionTimeout: 1800,
          maxLifetime: 28800,
        },
        additionalPolicies: ["bma-acr-policy.json"],
        tags: { "agentcore:template": "BedrockManagedAgents" },
      },
    },
  });
});

describe("template parameter help", () => {
  test("lists every Runtime template with its registry description", () => {
    const help = formatTemplateParameterHelp();

    expect(help).toStartWith("(template name)\nAvailable templates:\n");
    for (const name of RUNTIME_TEMPLATE_SHORTCUT_NAMES) {
      expect(help).toContain(name);
      expect(help).toContain(RUNTIME_TEMPLATE_SHORTCUTS[name].description);
    }
    expect(help).not.toContain(EMPTY_TEMPLATE_NAME);
  });

  test("can include the empty project template", () => {
    const help = formatTemplateParameterHelp({ includeEmpty: true });

    expect(help).toContain(EMPTY_TEMPLATE_NAME);
    expect(help).toContain("empty project with no Runtime or harness");
  });
});

test("default memory names fit the service limit for long runtime names", () => {
  const memory = getDefaultMemorySpec("a".repeat(48));

  expect(memory.name).toBe(`${"a".repeat(42)}Memory`);
  expect(memory.name).toHaveLength(48);
});

describe("Box gateway entry", () => {
  test("the Bedrock target calls and signs for the region build gives it", () => {
    expect(getBoxGatewayBedrockTargetSpec("eu-central-1")).toEqual({
      name: "bedrock",
      targetType: "passthrough",
      passthrough: {
        endpoint: "https://bedrock-runtime.eu-central-1.amazonaws.com",
        protocolType: "CUSTOM",
      },
      outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "bedrock", region: "eu-central-1" },
    });
  });

  test("is a valid project gateway, named after the runtime's Box gateway", () => {
    const entry = getBoxGatewayBedrockEntry("my_agent");
    expect(AgentCoreGatewaySchema.parse(entry)).toEqual(entry);
    expect(entry.name).toBe("my-agent-box");
  });

  test.each([
    "agent-python-strands-box",
    "agent-python-strands-box-container",
    "agent-python-minimal-box",
    "agent-python-langchain-box",
  ] as const)("%s declares it with no target, which build adds", (template) => {
    expect(
      resolveRuntimeTemplateShortcut(template, { runtimeName: "agent" }).boxGatewayEntry,
    ).toEqual({
      name: "agent-box",
      protocolType: "None",
      authorizerType: "AWS_IAM",
      enableSemanticSearch: true,
      exceptionLevel: "NONE",
      targets: [],
    });
  });

  test.each([
    "agent-python-strands",
    "agent-python-strands-container",
    "agent-typescript-strands",
    "agent-python-langchain",
    "agent-python-minimal",
    "mcp-python-fastmcp",
    "environment-python-bma",
  ] as const)("%s, which is not a box template, declares none", (template) => {
    expect(resolveRuntimeTemplateShortcut(template).boxGatewayEntry).toBeUndefined();
  });

  test.each([
    ["OpenAI", { modelProvider: "OpenAI", apiKey: "sk-test" }],
    ["Anthropic", { modelProvider: "Anthropic", apiKey: "sk-test" }],
    ["Gemini", { modelProvider: "Gemini", apiKey: "test" }],
    ["LiteLLM with a non-Bedrock model", { modelProvider: "LiteLLM", modelId: "openai/gpt-4o" }],
  ] as const)("%s: the agent declares none", (_label, overrides) => {
    expect(
      resolveRuntimeTemplateShortcut("agent-python-strands-box", overrides).boxGatewayEntry,
    ).toBeUndefined();
  });

  test("a LiteLLM agent on its default Bedrock model declares the Box gateway", () => {
    expect(
      resolveRuntimeTemplateShortcut("agent-python-strands-box", { modelProvider: "LiteLLM" })
        .boxGatewayEntry?.targets,
    ).toEqual([]);
  });
});
