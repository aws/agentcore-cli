import { describe, expect, test } from "bun:test";
import { AgentCoreGatewaySchema } from "../../projectSchemas/gateway";
import {
  EMPTY_TEMPLATE_NAME,
  formatTemplateParameterHelp,
  getBoxGatewaySpec,
  getDefaultMemorySpec,
  PROJECT_TEMPLATE_NAMES,
  resolveRuntimeTemplateShortcut,
  RUNTIME_TEMPLATE_SHORTCUT_NAMES,
  RUNTIME_TEMPLATE_SHORTCUTS,
} from "./shortcuts";

describe("template order", () => {
  test("groups by protocol, then language, framework, and build, with empty last", () => {
    expect(PROJECT_TEMPLATE_NAMES).toEqual([
      "agent-python-strands",
      "agent-python-strands-container",
      "agent-python-langchain",
      "environment-python-bma",
      "agent-python-minimal",
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
  const BEDROCK_TARGET = {
    name: "bedrock",
    targetType: "passthrough",
    passthrough: {
      endpoint: "https://bedrock-runtime.us-west-2.amazonaws.com",
      protocolType: "CUSTOM",
    },
    outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "bedrock", region: "us-west-2" },
  } as const;

  test("is a valid project gateway, with or without the Bedrock target", () => {
    for (const bedrockTarget of [true, false]) {
      const gateway = getBoxGatewaySpec({ bedrockTarget });
      expect(AgentCoreGatewaySchema.parse(gateway)).toEqual(gateway);
    }
  });

  test.each([
    "agent-python-strands",
    "agent-python-strands-container",
    "agent-typescript-strands",
    "a2a-python-strands",
    "agui-python-strands",
    "agent-python-langchain",
    "agent-typescript-vercel",
    "agent-python-minimal",
  ] as const)("%s declares it with the Bedrock target by default", (template) => {
    expect(resolveRuntimeTemplateShortcut(template).boxGateway).toEqual({
      name: "box",
      protocolType: "None",
      authorizerType: "AWS_IAM",
      enableSemanticSearch: true,
      exceptionLevel: "NONE",
      targets: [BEDROCK_TARGET],
    });
  });

  test("mcp-python-fastmcp, which calls no model yet, declares it with no targets", () => {
    expect(resolveRuntimeTemplateShortcut("mcp-python-fastmcp").boxGateway).toEqual(
      getBoxGatewaySpec({ bedrockTarget: false }),
    );
    expect(resolveRuntimeTemplateShortcut("mcp-python-fastmcp").boxGateway?.targets).toEqual([]);
  });

  test("environment-python-bma, a Bedrock Managed Agents environment, declares none", () => {
    expect(resolveRuntimeTemplateShortcut("environment-python-bma").boxGateway).toBeUndefined();
  });

  test.each([
    ["OpenAI", { modelProvider: "OpenAI", apiKey: "sk-test" }],
    ["Anthropic", { modelProvider: "Anthropic", apiKey: "sk-test" }],
    ["Gemini", { modelProvider: "Gemini", apiKey: "test" }],
    ["LiteLLM with a non-Bedrock model", { modelProvider: "LiteLLM", modelId: "openai/gpt-4o" }],
  ] as const)("%s: the agent gets the gateway with no Bedrock target", (_label, overrides) => {
    expect(
      resolveRuntimeTemplateShortcut("agent-python-strands", overrides).boxGateway?.targets,
    ).toEqual([]);
  });

  test("a LiteLLM agent on its default Bedrock model keeps the Bedrock target", () => {
    expect(
      resolveRuntimeTemplateShortcut("agent-python-strands", { modelProvider: "LiteLLM" })
        .boxGateway?.targets,
    ).toEqual([BEDROCK_TARGET]);
  });
});
