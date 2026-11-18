import { describe, expect, test } from "bun:test";
import {
  EMPTY_TEMPLATE_NAME,
  formatTemplateParameterHelp,
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
      "mcp-python-fastmcp-box",
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

describe("box templates", () => {
  test.each([
    "agent-python-strands-box",
    "agent-python-strands-box-container",
    "agent-python-minimal-box",
    "agent-python-langchain-box",
    "a2a-python-strands-box",
    "agui-python-strands-box",
    "mcp-python-fastmcp-box",
  ] as const)("%s runs its agent in a box", (template) => {
    expect(resolveRuntimeTemplateShortcut(template).box).toBe(true);
  });

  test.each([
    "agent-python-strands",
    "agent-python-strands-container",
    "agent-typescript-strands",
    "agent-python-langchain",
    "agent-python-minimal",
    "mcp-python-fastmcp",
    "environment-python-bma",
  ] as const)("%s, which is not a box template, runs its agent the usual way", (template) => {
    expect(resolveRuntimeTemplateShortcut(template).box).toBeUndefined();
  });
});
