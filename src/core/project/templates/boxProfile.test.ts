import { describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
import {
  resolveRuntimeTemplateShortcut,
  type RuntimeTemplateShortcutName,
} from "../../../handlers/project/shortcuts";
import type { ModelProvider } from "../../../handlers/project/types";
import { hasBoxProfile, renderBoxProfile } from "./boxProfile";

function template(name: RuntimeTemplateShortcutName, overrides: Record<string, string> = {}) {
  return resolveRuntimeTemplateShortcut(name, { runtimeName: "agent", ...overrides });
}

function profile(name: RuntimeTemplateShortcutName, overrides: Record<string, string> = {}) {
  return parse(renderBoxProfile("V3Demo", template(name, overrides))!) as Record<string, any>;
}

const STRANDS = template("agent-python-strands");

const VENV_GRANTS = {
  read: [
    "${{ workspace }}/app/agent",
    "${{ workspace }}/app/agent/.venv",
    { path: "${{ home }}/.local/share/uv/python", optional: true },
  ],
  exec: [
    { path: "${{ workspace }}/app/agent/.venv", optional: true },
    { path: "${{ home }}/.local/share/uv/python", optional: true },
  ],
  deny_write: [{ path: "${{ workspace }}/app/agent/.venv", optional: true }],
};

const UVICORN = [
  "${{ workspace }}/app/agent/.venv/bin/python",
  "-m",
  "uvicorn",
  "main:app",
  "--app-dir",
  "${{ workspace }}/app/agent",
  "--reload",
  "--reload-dir",
  "${{ workspace }}/app/agent",
  "--host",
  "127.0.0.1",
  "--port",
  "8081",
];

describe("renderBoxProfile", () => {
  test("runs the Strands agent from the project's venv, reached through ingress", () => {
    expect(parse(renderBoxProfile("V3Demo", STRANDS)!) as unknown).toEqual({
      packs: ["box/base", "box/bedrock"],
      profile: { name: "V3Demo" },
      options: { bedrock: { region: "us-west-2" } },
      agent: {
        command: UVICORN,
        env: { LOCAL_DEV: "1", PORT: "8081", PYTHONUNBUFFERED: "1", PYTHONUTF8: "1" },
        filesystem: VENV_GRANTS,
        ingress: [{ listen: "127.0.0.1:8080", workload_port: 8081 }],
      },
      egress: { bedrock: { secret: { ref: "aws://default" } } },
    });
  });

  test("names itself after the project, so `box run .box/profile.toml` can load it by its path", () => {
    expect(profile("agent-python-minimal").profile).toEqual({ name: "V3Demo" });
    expect(renderBoxProfile("V3Demo", STRANDS)).toContain("Run `box run .box/profile.toml`");
  });

  test("names no host path, so the profile works on any machine and after a move", () => {
    const text = renderBoxProfile("V3Demo", STRANDS)!;
    expect(text).not.toContain(process.cwd());
    expect(text).not.toMatch(/"\/(Users|home)\//);
  });

  test.each(["agent-python-minimal", "agent-python-langchain"] as const)(
    "runs %s with uvicorn on Bedrock, like the Strands agent",
    (name) => {
      const { packs, agent, egress } = profile(name);
      expect(packs).toEqual(["box/base", "box/bedrock"]);
      expect(agent.command).toEqual(UVICORN);
      expect(agent.filesystem).toEqual(VENV_GRANTS);
      expect(egress.bedrock).toEqual({ secret: { ref: "aws://default" } });
    },
  );

  test.each([
    ["agui-python-strands", "PORT", 8080],
    ["a2a-python-strands", "A2A_PORT", 9000],
    ["mcp-python-fastmcp", "FASTMCP_PORT", 8000],
  ] as const)("runs %s as a module on its own port, one above dev's", (name, variable, devPort) => {
    const { agent } = profile(name);
    expect(agent.command).toEqual(["${{ workspace }}/app/agent/.venv/bin/python", "-m", "main"]);
    expect(agent.env).toMatchObject({
      PYTHONPATH: "${{ workspace }}/app/agent",
      [variable]: String(devPort + 1),
    });
    expect(agent.ingress).toEqual([{ listen: `127.0.0.1:${devPort}`, workload_port: devPort + 1 }]);
    expect(agent.filesystem).toEqual(VENV_GRANTS);
  });

  test("gives the MCP server no route, because it calls no model", () => {
    const mcp = profile("mcp-python-fastmcp");
    expect(mcp.packs).toEqual(["box/base"]);
    expect(mcp.options).toBeUndefined();
    expect(mcp.egress).toBeUndefined();
  });

  test.each([
    [
      "OpenAI",
      {},
      "openai",
      {
        destinations: ["api.openai.com"],
        secret: { ref: "env://AGENTCORE_CREDENTIAL_AGENTOPENAIAPIKEY" },
      },
    ],
    [
      "Anthropic",
      {},
      "anthropic",
      {
        destinations: ["api.anthropic.com"],
        secret: {
          ref: "env://AGENTCORE_CREDENTIAL_AGENTANTHROPICAPIKEY",
          header: "x-api-key",
          phantom_prefix: "sk-ant-",
        },
      },
    ],
    [
      "Gemini",
      {},
      "gemini",
      {
        destinations: ["generativelanguage.googleapis.com"],
        secret: { ref: "env://AGENTCORE_CREDENTIAL_AGENTGEMINIAPIKEY", header: "x-goog-api-key" },
      },
    ],
    [
      "OpenAICompatible",
      { apiBase: "https://models.example.com/v1", modelId: "my-model" },
      "openai-compatible",
      {
        destinations: ["models.example.com"],
        secret: { ref: "env://AGENTCORE_CREDENTIAL_AGENTOPENAICOMPATIBLEAPIKEY" },
      },
    ],
    [
      "LiteLLM",
      { modelId: "openai/gpt-4o" },
      "openai",
      {
        destinations: ["api.openai.com"],
        secret: { ref: "env://AGENTCORE_CREDENTIAL_AGENTLITELLMAPIKEY" },
      },
    ],
  ] as const)(
    "routes %s model calls with the API key from the environment, and not through Bedrock",
    (provider, overrides, route, expected) => {
      const { packs, options, egress } = profile("agent-python-strands", {
        modelProvider: provider as ModelProvider,
        apiKey: "sk-test",
        ...overrides,
      });
      expect(packs).toEqual(["box/base"]);
      expect(options).toBeUndefined();
      expect(egress).toEqual({ [route]: expected });
    },
  );

  test("routes a LiteLLM agent on a bedrock/ model through Bedrock", () => {
    const { packs, egress } = profile("agent-python-strands", { modelProvider: "LiteLLM" });
    expect(packs).toEqual(["box/base", "box/bedrock"]);
    expect(egress).toEqual({ bedrock: { secret: { ref: "aws://default" } } });
  });

  test("runs the Strands container image's agent from /app, where box starts in the image", () => {
    const container = profile("agent-python-strands-container");
    expect(container.packs).toEqual(["box/base", "box/bedrock"]);
    expect(container.agent).toEqual({
      command: [
        "${{ workspace }}/.venv/bin/python",
        "-m",
        "uvicorn",
        "main:app",
        "--app-dir",
        "${{ workspace }}",
        "--reload",
        "--reload-dir",
        "${{ workspace }}",
        "--host",
        "127.0.0.1",
        "--port",
        "8081",
      ],
      env: { LOCAL_DEV: "1", PORT: "8081", PYTHONUNBUFFERED: "1", PYTHONUTF8: "1" },
      filesystem: {
        read: ["${{ workspace }}", "/usr/local/lib", "/usr/lib/aarch64-linux-gnu"],
        exec: [
          { path: "${{ workspace }}/.venv", optional: true },
          "/usr/local/bin",
          "/usr/local/lib",
          "/usr/lib/aarch64-linux-gnu",
        ],
        deny_write: [{ path: "${{ workspace }}/.venv", optional: true }],
      },
      ingress: [{ listen: "0.0.0.0:8080", workload_port: 8081 }],
    });
    expect(container.egress.bedrock).toEqual({ secret: { ref: "aws://default" } });
  });

  test.each([
    "environment-python-bma",
    "agent-typescript-strands",
    "agent-typescript-vercel",
  ] as const)("writes no profile for %s yet", (name) => {
    const runtime = resolveRuntimeTemplateShortcut(name);
    expect(hasBoxProfile(runtime)).toBe(false);
    expect(renderBoxProfile("V3Demo", runtime)).toBeUndefined();
  });
});
