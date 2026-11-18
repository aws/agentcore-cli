import { describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
import {
  resolveRuntimeTemplateShortcut,
  type RuntimeTemplateShortcutName,
} from "../../../handlers/project/shortcuts";
import type { ModelProvider } from "../../../handlers/project/types";
import { boxProfileWarnings, hasBoxProfile, renderBoxProfile } from "./boxProfile";

/**
 * The scaffold input of a template, as a box template would give it: the renderer takes every
 * template's shape, though create writes a profile only for the box templates.
 */
function template(name: RuntimeTemplateShortcutName, overrides: Record<string, string> = {}) {
  return {
    ...resolveRuntimeTemplateShortcut(name, { runtimeName: "agent", ...overrides }),
    box: true,
  };
}

/** The parts of a rendered box profile these tests read. */
type BoxProfile = {
  packs: string[];
  profile: { name: string };
  project?: { access: string };
  options?: { bedrock?: { region?: string } };
  agent: {
    command: string[];
    env: Record<string, string>;
    filesystem: { read: unknown[]; exec: unknown[]; deny_write?: unknown[] };
    ingress: { listen: string; workload_port: number }[];
  };
  tool?: Record<string, { filesystem: { deny_write: unknown[] } }>;
  egress?: Record<string, Record<string, unknown>>;
};

function profile(name: RuntimeTemplateShortcutName, overrides: Record<string, string> = {}) {
  return parse(renderBoxProfile("V3Demo", template(name, overrides))!) as unknown as BoxProfile;
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
      project: { access: "write" },
      options: { bedrock: { region: "us-west-2" } },
      agent: {
        command: UVICORN,
        env: { LOCAL_DEV: "1", PORT: "8081", PYTHONUNBUFFERED: "1", PYTHONUTF8: "1" },
        filesystem: VENV_GRANTS,
        ingress: [{ listen: "127.0.0.1:8080", workload_port: 8081 }],
      },
      tool: { uname: { filesystem: { deny_write: VENV_GRANTS.deny_write } } },
      egress: { bedrock: { secret: { ref: "aws://default" } } },
    });
  });

  test("names itself after the project, so `box run .box/agent/local/profile.toml` can load it by its path", () => {
    expect(profile("agent-python-minimal").profile).toEqual({ name: "V3Demo" });
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
      expect(egress?.bedrock).toEqual({ secret: { ref: "aws://default" } });
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

  test.each([
    ["openai/gpt-4o", "openai", "OPENAI_API_KEY"],
    ["anthropic/claude-sonnet-4-5", "anthropic", "ANTHROPIC_API_KEY"],
    ["gemini/gemini-2.5-flash", "gemini", "GEMINI_API_KEY"],
  ] as const)(
    "reads a LiteLLM %s key created without --api-key from LiteLLM's own variable",
    (modelId, route, variable) => {
      const runtime = template("agent-python-strands", { modelProvider: "LiteLLM", modelId });
      const { egress } = parse(renderBoxProfile("V3Demo", runtime)!) as {
        egress: Record<string, { secret: { ref: string } }>;
      };
      expect(egress[route]?.secret.ref).toBe(`env://${variable}`);
      expect(boxProfileWarnings(runtime)).toEqual([
        `the box profile reads the ${route} API key from ${variable}: set it in ` +
          "agentcore/.env.local or your shell before `agentcore dev`, or the agent's model calls " +
          "go out with no key",
      ]);
    },
  );

  test("does not warn when the LiteLLM agent has a key, or calls Bedrock", () => {
    const keyed = { modelProvider: "LiteLLM", modelId: "openai/gpt-4o", apiKey: "sk-test" };
    expect(boxProfileWarnings(template("agent-python-strands", keyed))).toEqual([]);
    expect(boxProfileWarnings(template("agent-python-strands", { modelProvider: "LiteLLM" }))).toEqual(
      [],
    );
  });

  test("calls Bedrock in the region create resolved", () => {
    const text = renderBoxProfile("V3Demo", STRANDS, "eu-west-1")!;
    expect((parse(text) as { options: unknown }).options).toEqual({
      bedrock: { region: "eu-west-1" },
    });
  });

  test("warns that a LiteLLM agent on a provider with no route gets no model route", () => {
    const groq = { modelProvider: "LiteLLM", modelId: "groq/llama3", apiKey: "sk-test" };
    const runtime = template("agent-python-strands", groq);
    expect(profile("agent-python-strands", groq).egress).toBeUndefined();
    expect(boxProfileWarnings(runtime)).toEqual([
      "the box profile has no route for the LiteLLM model 'groq/llama3': add an [egress.groq] " +
        "section with its provider's host to .box/agent/local/profile.toml, or the box blocks the agent's " +
        "model calls",
    ]);
  });

  test("keeps the port of an OpenAI-compatible endpoint in its destination", () => {
    const { egress } = profile("agent-python-strands", {
      modelProvider: "OpenAICompatible",
      modelId: "llama3",
      apiKey: "sk-test",
      apiBase: "http://localhost:11434/v1",
    });
    expect(egress?.["openai-compatible"]?.destinations).toEqual(["localhost:11434"]);
  });

  test("runs the Strands container image's agent from /app, where box starts in the image", () => {
    const container = profile("agent-python-strands-container");
    expect(container.packs).toEqual(["box/base", "box/bedrock"]);
    // The image's code and venv are in /app, the workspace, not in app/<runtime>.
    expect(container.agent.command.slice(0, 6)).toEqual([
      "${{ workspace }}/.venv/bin/python",
      "-m",
      "uvicorn",
      "main:app",
      "--app-dir",
      "${{ workspace }}",
    ]);
    expect(container.agent.filesystem.deny_write).toEqual([
      { path: "${{ workspace }}/.venv", optional: true },
    ]);
    // The container's port is reached on its own address, not on loopback.
    expect(container.agent.ingress).toEqual([{ listen: "0.0.0.0:8080", workload_port: 8081 }]);
    // The image's agent only reads /app, and no tool gets a write grant to list the venv in.
    expect(container.project).toEqual({ access: "read" });
    expect(container.tool).toBeUndefined();
    expect(container.egress?.bedrock).toEqual({ secret: { ref: "aws://default" } });
  });

  test.each([
    "environment-python-bma",
    "agent-typescript-strands",
    "agent-typescript-vercel",
    "agent-python-strands",
    "agent-python-strands-container",
    "agent-python-langchain",
    "mcp-python-fastmcp",
  ] as const)("writes no profile for %s, which is not a box template", (name) => {
    const runtime = resolveRuntimeTemplateShortcut(name);
    expect(hasBoxProfile(runtime)).toBe(false);
    expect(renderBoxProfile("V3Demo", runtime)).toBeUndefined();
  });
});
