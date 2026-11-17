import { describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
import { InputValidationError } from "../../../errors/errors";
import {
  getBoxGatewayAgentCoreTargetSpec,
  getBoxGatewayBedrockTargetSpec,
  resolveRuntimeTemplateShortcut,
  type RuntimeTemplateShortcutName,
} from "../../../handlers/project/shortcuts";
import type { ModelProvider } from "../../../handlers/project/types";
import type { AgentCoreGatewayTarget } from "../../../projectSchemas/gateway";
import { boxGatewaySpec, type ProjectSpec } from "../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import {
  boxProfileWarnings,
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
    { path: "${{ workspace }}/app/agent/.venv", optional: true },
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

  test("names box's ingress port, not the agent's, in the A2A agent card", () => {
    const { agent } = profile("a2a-python-strands");
    expect(agent.env).toMatchObject({
      A2A_PORT: "9001",
      AGENTCORE_RUNTIME_URL: "http://localhost:9000/",
    });
    expect(profile("agui-python-strands").agent.env).not.toHaveProperty("AGENTCORE_RUNTIME_URL");
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
    expect(
      boxProfileWarnings(template("agent-python-strands", { modelProvider: "LiteLLM" })),
    ).toEqual([]);
  });

  test("warns that a LiteLLM agent on a provider with no route gets no model route", () => {
    const groq = { modelProvider: "LiteLLM", modelId: "groq/llama3", apiKey: "sk-test" };
    expect(profile("agent-python-strands", groq).egress).toBeUndefined();
    expect(boxProfileWarnings(template("agent-python-strands", groq))).toEqual([
      "the box profile has no route for the LiteLLM model 'groq/llama3': add an [egress.groq] " +
        "section with its provider's host to .box/profile.toml, or the box blocks the agent's " +
        "model calls",
    ]);
  });

  test("calls Bedrock in the region create resolved", () => {
    const text = renderBoxProfile("V3Demo", STRANDS, "eu-west-1")!;
    expect((parse(text) as { options: unknown }).options).toEqual({
      bedrock: { region: "eu-west-1" },
    });
  });

  test("keeps the port of an OpenAI-compatible endpoint in its destination", () => {
    const { egress } = profile("agent-python-strands", {
      modelProvider: "OpenAICompatible",
      modelId: "llama3",
      apiKey: "sk-test",
      apiBase: "http://localhost:11434/v1",
    });
    expect(egress["openai-compatible"].destinations).toEqual(["localhost:11434"]);
  });

  test("gives an OpenAI-compatible agent with no base URL no route, rather than OpenAI's", () => {
    // The schema requires --api-base, so drop it from a valid input; the type still allows it.
    const runtime = {
      ...template("agent-python-strands", {
        modelProvider: "OpenAICompatible",
        modelId: "llama3",
        apiKey: "sk-test",
        apiBase: "http://localhost:11434/v1",
      }),
      apiBase: undefined,
    };
    const text = renderBoxProfile("V3Demo", runtime)!;
    expect(text).not.toContain("api.openai.com");
    expect((parse(text) as { egress?: unknown }).egress).toBeUndefined();
  });

  test("names the provider section generically for a LiteLLM model ID with no prefix", () => {
    const runtime = template("agent-python-strands", {
      modelProvider: "LiteLLM",
      modelId: "gpt-4o",
      apiKey: "sk-test",
    });
    expect(boxProfileWarnings(runtime)).toEqual([
      "the box profile has no route for the LiteLLM model 'gpt-4o': add an [egress.<provider>] " +
        "section with its provider's host to .box/profile.toml (or use an openai/, anthropic/ or " +
        "gemini/ model ID), or the box blocks the agent's model calls",
    ]);
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
  return parse(
    renderBoxProfile("V3Demo", template(name, overrides), "us-west-2", "runtime")!,
  ) as Record<string, any>;
}

/** The stand-in AWS keys the Runtime profile gives boto3, which box re-signs for the gateway. */
const RUNTIME_AWS_STAND_INS = {
  AWS_ACCESS_KEY_ID: "box-stand-in",
  AWS_SECRET_ACCESS_KEY: "box-stand-in",
};

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
  test("names no model host of its own: agentcore.json has no base URL, the Box gateway routes it", () => {
    // What deploy renders from agentcore.json, which records no --api-base.
    const spec = {
      name: "V3Demo",
      runtimes: [{ name: "agent", build: "CodeZip", protocol: "HTTP", modelProvider: "OpenAICompatible" }],
      agentCoreGateways: [],
    } as unknown as ProjectSpec;
    const text = renderRuntimeBoxProfile(spec, spec.runtimes[0]!);
    expect(text).not.toContain("api.openai.com");
    expect((parse(text) as { egress?: unknown }).egress).toBeUndefined();
  });

  test("runs agent-python-strands from the zip with the Runtime's Python, for start.sh to fill in", () => {
    const text = renderBoxProfile(
      "V3Demo",
      template("agent-python-strands"),
      "us-west-2",
      "runtime",
    )!;
    // start.sh replaces this line with the deployed Memories' and Gateways' variables.
    expect(text).toContain('AWS_SECRET_ACCESS_KEY = "box-stand-in"\n# @AGENT_ENV@\n');
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
          ...RUNTIME_AWS_STAND_INS,
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
          env: {
            PORT: "8081",
            PYTHONUNBUFFERED: "1",
            PYTHONUTF8: "1",
            ...RUNTIME_AWS_STAND_INS,
          },
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
  const GITHUB: AgentCoreGatewayTarget = {
    name: "github",
    targetType: "passthrough",
    passthrough: { endpoint: "https://api.github.com" },
    outboundAuth: { type: "NONE" },
  } as AgentCoreGatewayTarget;

  function passthrough(name: string, endpoint: string): AgentCoreGatewayTarget {
    return { ...GITHUB, name, passthrough: { endpoint } } as AgentCoreGatewayTarget;
  }

  /** A Box project whose runtime `agent`'s Box gateway holds `targets`. */
  function spec(
    memories: string[],
    runtime: Partial<ProjectRuntime> = {},
    targets: AgentCoreGatewayTarget[] = [],
  ) {
    return {
      name: "V3Demo",
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
      memories: memories.map((name) => ({ name, eventExpiryDuration: 30, strategies: [] })),
      projectType: "box",
      agentCoreGateways: [{ ...boxGatewaySpec("agent"), targets }],
    } as unknown as ProjectSpec;
  }

  const egressOf = (project: ProjectSpec) =>
    (parse(renderRuntimeBoxProfile(project, project.runtimes[0]!)).egress ?? {}) as Record<
      string,
      unknown
    >;

  /** The route a passthrough target gets: its host, sent to the target, signed for the gateway. */
  const gatewayRoute = (target: string, host: string) => ({
    // No destination secret: the backend's own auth signs the call to the gateway.
    destinations: [host],
    backends: [
      {
        url: `@GATEWAY_BOX_URL@/${target}`,
        auth: { ref: "aws://default", aws: { service: "bedrock-agentcore", region: "us-west-2" } },
      },
    ],
  });

  test("names the model's policy files under policies, at the top of the profile", () => {
    const project = spec([]);
    const text = renderRuntimeBoxProfile(project, project.runtimes[0]!, {
      policyFiles: ["policy.dw", "rules/extra.dw"],
    });

    expect(parse(text).policies).toEqual(["policy.dw", "rules/extra.dw"]);
    expect(text).toContain('policies = ["policy.dw", "rules/extra.dw"]\n');
    expect(parse(renderRuntimeBoxProfile(project, project.runtimes[0]!)).policies).toBeUndefined();
  });

  test("routes the default Memory's calls through the Box gateway's agentcore target", () => {
    const project = spec(["agentMemory"], {}, [getBoxGatewayAgentCoreTargetSpec()]);

    expect(egressOf(project).agentcore).toEqual(
      gatewayRoute("agentcore", "bedrock-agentcore.us-west-2.amazonaws.com"),
    );
  });

  test("routes no Memory calls when the project has only another Memory", () => {
    expect(egressOf(spec(["ordersMemory"]))).toEqual({});
  });

  test("gives each passthrough target of the runtime's Box gateway one route to it", () => {
    const project = spec([], {}, [
      getBoxGatewayBedrockTargetSpec(),
      getBoxGatewayAgentCoreTargetSpec(),
      GITHUB,
    ]);

    expect(egressOf(project)).toEqual({
      // The model calls go through the gateway's bedrock target, which build adds.
      bedrock: gatewayRoute("bedrock", "bedrock-runtime.us-west-2.amazonaws.com"),
      agentcore: gatewayRoute("agentcore", "bedrock-agentcore.us-west-2.amazonaws.com"),
      github: gatewayRoute("github", "api.github.com"),
    });
  });

  test("signs each route for the gateway in the region build builds for", () => {
    const project = spec([], {}, [getBoxGatewayBedrockTargetSpec("eu-central-1")]);
    const profile = parse(
      renderRuntimeBoxProfile(project, project.runtimes[0]!, {
        policyFiles: [],
        region: "eu-central-1",
      }),
    );

    expect(profile.options).toEqual({ bedrock: { region: "eu-central-1" } });
    expect((profile.egress as Record<string, unknown>).bedrock).toEqual({
      destinations: ["bedrock-runtime.eu-central-1.amazonaws.com"],
      backends: [
        {
          url: "@GATEWAY_BOX_URL@/bedrock",
          auth: {
            ref: "aws://default",
            aws: { service: "bedrock-agentcore", region: "eu-central-1" },
          },
        },
      ],
    });
  });

  test("keeps the endpoint's port, and quotes a target name that is not a bare TOML key", () => {
    const project = spec([], {}, [passthrough("tools.v2", "https://tools.example.com:8443/api")]);

    expect(egressOf(project)["tools.v2"]).toEqual(
      gatewayRoute("tools.v2", "tools.example.com:8443"),
    );
  });

  test("gives a target that is not passthrough no route", () => {
    const lambda = { name: "orders", targetType: "lambda" } as unknown as AgentCoreGatewayTarget;

    expect(egressOf(spec([], {}, [lambda]))).toEqual({});
  });

  test("finds the runtime's Box gateway by boundRuntime, not by name", () => {
    const project = spec([], {}, [GITHUB]);
    project.agentCoreGateways[0] = { ...project.agentCoreGateways[0]!, name: "renamed" };

    expect(egressOf(project).github).toEqual(gatewayRoute("github", "api.github.com"));
    expect(renderRuntimeBoxProfile(project, project.runtimes[0]!)).toContain(
      "through the 'renamed' gateway's 'github' target",
    );
  });

  test("routes nothing through a gateway outside a Box project", () => {
    const project = spec([], {}, [GITHUB]);
    delete (project as { projectType?: string }).projectType;

    expect(egressOf(project)).toEqual({});
  });

  test("refuses two passthrough targets for one host, which would give two routes to it", () => {
    const project = spec([], {}, [GITHUB, passthrough("github-v2", "https://api.github.com/v2")]);

    expect(() => renderRuntimeBoxProfile(project, project.runtimes[0]!)).toThrow(
      new InputValidationError(
        "gateway 'agent-box-egress' has two passthrough targets for api.github.com, 'github' and " +
          "'github-v2', so runtime 'agent' would get two routes to one host. Remove one of them.",
      ),
    );
  });

  test("renders the CodeZip form for start.py and the image form for a container", () => {
    const codeZip = spec(["agentMemory"]);
    const container = spec(["agentMemory"], { build: "Container", entrypoint: "main.py" });

    expect(renderRuntimeBoxProfile(codeZip, codeZip.runtimes[0]!)).toContain('"@PYTHON@"');
    expect(renderRuntimeBoxProfile(container, container.runtimes[0]!)).toContain(
      '"${{ workspace }}/.venv/bin/python"',
    );
  });

  test("signs no Bedrock route for an agent on another model provider", () => {
    const project = spec(["agentMemory"], { modelProvider: "OpenAI" }, [
      getBoxGatewayAgentCoreTargetSpec(),
    ]);

    expect(Object.keys(egressOf(project))).toEqual(["agentcore"]);
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
