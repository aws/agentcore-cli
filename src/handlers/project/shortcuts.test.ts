import { describe, expect, test } from "bun:test";
import {
  EMPTY_TEMPLATE_NAME,
  formatTemplateParameterHelp,
  getBoxGatewayBedrockTargetSpec,
  agentCoreDataPlaneHost,
  getDefaultMemorySpec,
  PROJECT_TEMPLATE_NAMES,
  RUNTIME_TEMPLATE_SHORTCUT_NAMES,
  RUNTIME_TEMPLATE_SHORTCUTS,
} from "./shortcuts";

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
      "a2a-python-strands-box",
      "agui-python-strands",
      "agui-python-strands-box",
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

describe("the Box gateway target and the Memory host", () => {
  test("take the DNS suffix of the partition of the region", () => {
    const endpoints = (region: string) => [
      getBoxGatewayBedrockTargetSpec(region).passthrough?.endpoint,
      `https://${agentCoreDataPlaneHost(region)}`,
    ];

    expect(endpoints("cn-north-1")).toEqual([
      "https://bedrock-runtime.cn-north-1.amazonaws.com.cn",
      "https://bedrock-agentcore.cn-north-1.amazonaws.com.cn",
    ]);
    expect(endpoints("us-gov-west-1")).toEqual([
      "https://bedrock-runtime.us-gov-west-1.amazonaws.com",
      "https://bedrock-agentcore.us-gov-west-1.amazonaws.com",
    ]);
    expect(endpoints("us-west-2")).toEqual([
      "https://bedrock-runtime.us-west-2.amazonaws.com",
      "https://bedrock-agentcore.us-west-2.amazonaws.com",
    ]);
  });
});
