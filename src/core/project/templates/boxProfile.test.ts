import { describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
import {
  getBoxGatewayAgentCoreTargetSpec,
  getBoxGatewayBedrockTargetSpec,
  getBoxGatewayEntry,
  resolveRuntimeTemplateShortcut,
  type RuntimeTemplateShortcutName,
} from "../../../handlers/project/shortcuts";
import type { ModelProvider } from "../../../handlers/project/types";
import type { AgentCoreGatewayTarget } from "../../../projectSchemas/gateway";
import type { ProjectSpec } from "../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import {
  hasBoxProfile,
  renderBoxProfile,
  renderRuntimeBoxProfile,
  runsBoxStartScript,
  startsInBoxOnCodeZip,
} from "./boxProfile";

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

function runtimeProfile(name: RuntimeTemplateShortcutName, overrides: Record<string, string> = {}) {
  return parse(renderBoxProfile("V3Demo", template(name, overrides), "runtime")!) as Record<
    string,
    any
  >;
}

const IMAGE_PYTHON_FILESYSTEM = {
  read: ["${{ workspace }}", "/usr/local/lib", "/usr/lib/aarch64-linux-gnu"],
  exec: [
    { path: "${{ workspace }}/.venv", optional: true },
    "/usr/local/bin",
    "/usr/local/lib",
    "/usr/lib/aarch64-linux-gnu",
  ],
  deny_write: [{ path: "${{ workspace }}/.venv", optional: true }],
};

describe("renderBoxProfile for AgentCore Runtime", () => {
  test("runs agent-python-strands from the zip with the Runtime's Python, for start.sh to fill in", () => {
    const text = renderBoxProfile("V3Demo", template("agent-python-strands"), "runtime")!;
    // start.sh replaces this line with the deployed Memories' and Gateways' variables.
    expect(text).toContain('PYTHONUTF8 = "1"\n# @AGENT_ENV@\n');
    expect(parse(text)).toEqual({
      packs: ["box/base", "box/bedrock"],
      profile: { name: "V3Demo" },
      options: { bedrock: { region: "us-west-2" } },
      agent: {
        command: [
          "@PYTHON@",
          "-m",
          "uvicorn",
          "main:app",
          "--app-dir",
          "@CODE@",
          "--host",
          "127.0.0.1",
          "--port",
          "8081",
        ],
        env: {
          PORT: "8081",
          PYTHONPATH: "@CODE@/.box-dist/ffi:@CODE@",
          PYTHONUNBUFFERED: "1",
          PYTHONUTF8: "1",
        },
        filesystem: {
          read: ["@CODE@", "@PYTHON_PREFIX@", "/usr/lib64", "/lib64"],
          exec: ["@CODE@", "@PYTHON_PREFIX@"],
        },
        ingress: [{ listen: "0.0.0.0:8080", workload_port: 8081 }],
      },
    });
  });

  test.each(["agent-python-strands-container"] as const)(
    "runs %s from /app without --reload, signing calls with the Runtime's role",
    (name) => {
      expect(runtimeProfile(name)).toEqual({
        packs: ["box/base", "box/bedrock"],
        profile: { name: "V3Demo" },
        options: { bedrock: { region: "us-west-2" } },
        agent: {
          command: [
            "${{ workspace }}/.venv/bin/python",
            "-m",
            "uvicorn",
            "main:app",
            "--app-dir",
            "${{ workspace }}",
            "--host",
            "127.0.0.1",
            "--port",
            "8081",
          ],
          env: { PORT: "8081", PYTHONUNBUFFERED: "1", PYTHONUTF8: "1" },
          filesystem: IMAGE_PYTHON_FILESYSTEM,
          ingress: [{ listen: "0.0.0.0:8080", workload_port: 8081 }],
        },
      });
    },
  );

  test("serves the MCP server on all interfaces on the Runtime", () => {
    const mcp = runtimeProfile("mcp-python-fastmcp");
    expect(mcp.agent.ingress).toEqual([{ listen: "0.0.0.0:8000", workload_port: 8001 }]);
    // The template has no default Memory route; build and deploy add it when the project has one.
    expect(mcp.egress).toBeUndefined();
  });

  test("gives a non-Bedrock model no route, since its key comes from AgentCore Identity", () => {
    const openai = runtimeProfile("agent-python-strands", {
      modelProvider: "OpenAI",
      apiKey: "sk-test",
    });
    expect(openai.packs).toEqual(["box/base"]);
    expect(openai.egress).toBeUndefined();
  });
});

describe("renderRuntimeBoxProfile", () => {
  const GITHUB = {
    name: "github",
    targetType: "passthrough",
    passthrough: { endpoint: "https://api.github.com", protocolType: "CUSTOM" },
  } as AgentCoreGatewayTarget;

  /** A Box project whose runtime `agent` has a Box gateway with `targets`. */
  function spec(targets: AgentCoreGatewayTarget[], runtime: Partial<ProjectRuntime> = {}) {
    return {
      name: "V3Demo",
      projectType: "box",
      runtimes: [
        {
          name: "agent",
          build: "CodeZip",
          entrypoint: "start.py",
          codeLocation: "app/agent",
          protocol: "HTTP",
          modelProvider: "Bedrock",
          ...runtime,
        } as ProjectRuntime,
      ],
      memories: [{ name: "agentMemory", eventExpiryDuration: 30, strategies: [] }],
      agentCoreGateways: [{ ...getBoxGatewayEntry("agent"), targets }],
    } as unknown as ProjectSpec;
  }

  type Egress = Record<string, { secret?: { ref?: string }; backends?: { url: string }[] }>;
  const egressOf = (project: ProjectSpec) =>
    (parse(renderRuntimeBoxProfile(project, project.runtimes[0]!)).egress ?? {}) as Egress;
  const bedrock = getBoxGatewayBedrockTargetSpec();
  const agentcore = getBoxGatewayAgentCoreTargetSpec();

  test.each([
    ["Bedrock and Memory", [bedrock, agentcore], {}],
    ["Bedrock only", [bedrock], {}],
    ["Memory only, on OpenAI", [agentcore], { modelProvider: "OpenAI" }],
    ["a target the user added", [bedrock, agentcore, GITHUB], {}],
    ["a container", [bedrock, agentcore], { build: "Container" }],
  ] as const)(
    "has one route for each Box gateway target, sent to that target (%s)",
    (_, targets, runtime) => {
      const egress = egressOf(spec([...targets], runtime as Partial<ProjectRuntime>));

      expect(Object.keys(egress).sort()).toEqual(targets.map(({ name }) => name).sort());
      for (const [name, route] of Object.entries(egress)) {
        expect(route.backends?.map(({ url }) => url)).toEqual([`@GATEWAY_BOX_URL@/${name}`]);
        // Box refuses a signed destination secret beside a backend.
        expect(route.secret?.ref ?? "env://").toStartWith("env://");
      }
    },
  );

  test("routes a target's endpoint host to the target, signed for the gateway", () => {
    expect(egressOf(spec([GITHUB])).github as unknown).toEqual({
      destinations: ["api.github.com"],
      backends: [
        {
          url: "@GATEWAY_BOX_URL@/github",
          auth: { ref: "aws://", aws: { service: "bedrock-agentcore", region: "us-west-2" } },
        },
      ],
    });
  });

  test("routes the default Memory's calls through the Box gateway's agentcore target", () => {
    expect(egressOf(spec([agentcore])).agentcore as unknown).toEqual({
      // No destination secret: the backend's own auth signs the call to the gateway.
      destinations: ["bedrock-agentcore.us-west-2.amazonaws.com"],
      backends: [
        {
          url: "@GATEWAY_BOX_URL@/agentcore",
          auth: { ref: "aws://", aws: { service: "bedrock-agentcore", region: "us-west-2" } },
        },
      ],
    });
  });

  test("has no route without a Box gateway target, whatever the model provider", () => {
    expect(egressOf(spec([]))).toEqual({});
  });

  test("has no route outside a Box project, which has no Box gateway", () => {
    const project = { ...spec([bedrock, agentcore]), projectType: undefined } as ProjectSpec;
    expect(egressOf(project)).toEqual({});
  });

  test("renders the CodeZip form for start.py and the image form for a container", () => {
    const codeZip = spec([bedrock]);
    const container = spec([bedrock], { build: "Container", entrypoint: "main.py" });

    expect(renderRuntimeBoxProfile(codeZip, codeZip.runtimes[0]!)).toContain('"@PYTHON@"');
    expect(renderRuntimeBoxProfile(container, container.runtimes[0]!)).toContain(
      '"${{ workspace }}/.venv/bin/python"',
    );
  });
});

describe("startsInBoxOnCodeZip", () => {
  test("starts every Python CodeZip template in a box, and no container or TypeScript one", () => {
    expect(startsInBoxOnCodeZip(template("agent-python-strands"))).toBe(true);
    expect(startsInBoxOnCodeZip(template("mcp-python-fastmcp"))).toBe(true);
    expect(startsInBoxOnCodeZip(template("agent-python-strands-container"))).toBe(false);
    expect(startsInBoxOnCodeZip(template("agent-typescript-strands"))).toBe(false);
  });

  test("recognizes the start script with or without a handler", () => {
    expect(runsBoxStartScript("start.py")).toBe(true);
    expect(runsBoxStartScript("start.py:app")).toBe(true);
    expect(runsBoxStartScript("main.py")).toBe(false);
  });
});
