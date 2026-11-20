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
import { cloudWatchTelemetry, withDeployRegion, type BoxNetworkHost } from "../boxNetwork";
import { boxGatewaySpec, type ProjectSpec } from "../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import {
  boxProfileWarnings,
  boxStartFolder,
  hasBoxProfile,
  renderAgentCoreCodeZipPack,
  renderAgentCorePack,
  renderBoxProfile,
  renderRuntimeBoxProfile,
  startsInBoxOnCodeZip,
} from "./boxProfile";

/** The scaffold input of a box template, as create resolves it from the shortcut table. */
function template(name: RuntimeTemplateShortcutName, overrides: Record<string, string> = {}) {
  const runtime = resolveRuntimeTemplateShortcut(name, { runtimeName: "agent", ...overrides });
  // The shortcut entry itself marks it a box template; the tests do not force it.
  expect(runtime.boxTemplate).toBe(true);
  return runtime;
}

function profile(name: RuntimeTemplateShortcutName, overrides: Record<string, string> = {}) {
  return parse(renderBoxProfile("V3Demo", template(name, overrides))!) as Record<string, any>;
}

const STRANDS = template("agent-python-strands-box");

const VENV_GRANTS = {
  read: [
    "${{ workspace }}",
    { path: "${{ workspace }}/.venv", optional: true },
    { path: "${{ home }}/.local/share/uv/python", optional: true },
  ],
  exec: [
    { path: "${{ workspace }}/.venv", optional: true },
    { path: "${{ home }}/.local/share/uv/python", optional: true },
  ],
  deny_write: [{ path: "${{ workspace }}/.venv", optional: true }],
};

const UVICORN = [
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

  test("names itself after the project, and the folder `agentcore dev` starts box in", () => {
    expect(profile("agent-python-minimal-box").profile).toEqual({ name: "V3Demo" });
    const text = renderBoxProfile("V3Demo", STRANDS)!;
    expect(text).toContain("runs `box run ../../.box/agent/local/profile.toml` there");
    expect(boxStartFolder(text, { build: "CodeZip", codeLocation: "app/agent/" })).toBe(
      "app/agent",
    );
  });

  // The folder comes from agentcore.json, so a profile's comments, which a user may edit, never
  // move box back to the project root and its project-wide grant.
  test("starts a CodeZip runtime's box in its code folder, whatever the profile's comments say", () => {
    const codeZip = { build: "CodeZip", codeLocation: "app/agent" };
    const text = renderBoxProfile("V3Demo", STRANDS)!;
    const noComments = text
      .split("\n")
      .filter((line) => !line.startsWith("#"))
      .join("\n");
    expect(boxStartFolder(noComments, codeZip)).toBe("app/agent");
    // A container profile describes the image's /app.
    expect(boxStartFolder(text, { build: "Container", codeLocation: "app/agent" })).toBe("");
    // A profile written before this names the code folder under the project root, so it runs there.
    expect(boxStartFolder('read = ["${{ workspace }}/app/agent"]\n', codeZip)).toBe("");
  });

  // agentcore dev starts box in app/<runtime>, so ${{ workspace }} and the project grant are that
  // folder: agentcore/.env.local, with the model's key, .git and agentcore/cdk lie outside them.
  test("grants the agent its own folder and no other folder of the project", () => {
    const { project, agent, tool } = profile("agent-python-strands-box", {
      modelProvider: "OpenAI",
      apiKey: "sk-test",
    });
    expect(project).toEqual({ access: "write" });
    for (const grant of [...agent.filesystem.read, ...agent.filesystem.exec]) {
      const path = typeof grant === "string" ? grant : grant.path;
      expect(path).not.toMatch(/agentcore|\.git|\.\./);
    }
    expect(JSON.stringify(tool)).not.toMatch(/agentcore|\.git|\.\./);
  });

  test("names no host path, so the profile works on any machine and after a move", () => {
    const text = renderBoxProfile("V3Demo", STRANDS)!;
    expect(text).not.toContain(process.cwd());
    expect(text).not.toMatch(/"\/(Users|home)\//);
  });

  test.each(["agent-python-minimal-box", "agent-python-langchain-box"] as const)(
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
    ["agui-python-strands-box", "PORT", 8080],
    ["a2a-python-strands-box", "A2A_PORT", 9000],
    ["mcp-python-fastmcp-box", "FASTMCP_PORT", 8000],
  ] as const)("runs %s as a module on its own port, one above dev's", (name, variable, devPort) => {
    const { agent } = profile(name);
    expect(agent.command).toEqual(["${{ workspace }}/.venv/bin/python", "-m", "main"]);
    expect(agent.env).toMatchObject({
      PYTHONPATH: "${{ workspace }}",
      [variable]: String(devPort + 1),
    });
    expect(agent.ingress).toEqual([{ listen: `127.0.0.1:${devPort}`, workload_port: devPort + 1 }]);
    expect(agent.filesystem).toEqual(VENV_GRANTS);
  });

  test("names box's ingress port, not the agent's, in the A2A agent card", () => {
    const { agent } = profile("a2a-python-strands-box");
    expect(agent.env).toMatchObject({
      A2A_PORT: "9001",
      AGENTCORE_RUNTIME_URL: "http://localhost:9000/",
    });
    expect(profile("agui-python-strands-box").agent.env).not.toHaveProperty(
      "AGENTCORE_RUNTIME_URL",
    );
  });

  test("gives the MCP server no route, because it calls no model", () => {
    const mcp = profile("mcp-python-fastmcp-box");
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
      const { packs, options, egress } = profile("agent-python-strands-box", {
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
    const { packs, egress } = profile("agent-python-strands-box", { modelProvider: "LiteLLM" });
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
      const runtime = template("agent-python-strands-box", { modelProvider: "LiteLLM", modelId });
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
    expect(boxProfileWarnings(template("agent-python-strands-box", keyed))).toEqual([]);
    expect(
      boxProfileWarnings(template("agent-python-strands-box", { modelProvider: "LiteLLM" })),
    ).toEqual([]);
  });

  test("warns that a LiteLLM agent on a provider with no route gets no model route", () => {
    const groq = { modelProvider: "LiteLLM", modelId: "groq/llama3", apiKey: "sk-test" };
    expect(profile("agent-python-strands-box", groq).egress).toBeUndefined();
    expect(boxProfileWarnings(template("agent-python-strands-box", groq))).toEqual([
      "the box profile has no route for the LiteLLM model 'groq/llama3': add an [egress.groq] " +
        "section with its provider's host to .box/agent/local/profile.toml, or the box blocks the agent's " +
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
    const { egress } = profile("agent-python-strands-box", {
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
      ...template("agent-python-strands-box", {
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
    const runtime = template("agent-python-strands-box", {
      modelProvider: "LiteLLM",
      modelId: "gpt-4o",
      apiKey: "sk-test",
    });
    expect(boxProfileWarnings(runtime)).toEqual([
      "the box profile has no route for the LiteLLM model 'gpt-4o': add an [egress.<provider>] " +
        "section with its provider's host to .box/agent/local/profile.toml (or use an openai/, anthropic/ or " +
        "gemini/ model ID), or the box blocks the agent's model calls",
    ]);
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

/** The Runtime's region on a Bedrock agent: box/bedrock sets AWS_REGION, the profile the rest. */
const RUNTIME_REGION_WITH_BEDROCK = { AWS_DEFAULT_REGION: "${{ inputs.aws.region }}" };

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
      runtimes: [
        { name: "agent", build: "CodeZip", protocol: "HTTP", modelProvider: "OpenAICompatible" },
      ],
      agentCoreGateways: [],
    } as unknown as ProjectSpec;
    const text = renderRuntimeBoxProfile(spec, spec.runtimes[0]!);
    expect(text).not.toContain("api.openai.com");
    expect((parse(text) as { egress?: unknown }).egress).toBeUndefined();
  });

  test("passes the Runtime's region to an agent that imports no box/bedrock", () => {
    const spec = {
      name: "V3Demo",
      runtimes: [{ name: "agent", build: "CodeZip", protocol: "HTTP", modelProvider: "OpenAI" }],
      agentCoreGateways: [],
    } as unknown as ProjectSpec;
    const profile = parse(renderRuntimeBoxProfile(spec, spec.runtimes[0]!)) as Record<string, any>;

    expect(profile.packs).not.toContain("box/bedrock");
    // The Memory client in the box calls the deploy region that the profile routes.
    expect(profile.agent.env.AWS_REGION).toBe("${{ inputs.aws.region }}");
    expect(profile.agent.env.AWS_DEFAULT_REGION).toBe("${{ inputs.aws.region }}");
  });

  test("gives an A2A agent card the Runtime's own URL, not the local ingress port", () => {
    const spec = {
      name: "V3Demo",
      runtimes: [{ name: "agent", build: "CodeZip", protocol: "A2A", modelProvider: "Bedrock" }],
      agentCoreGateways: [],
    } as unknown as ProjectSpec;
    const profile = parse(renderRuntimeBoxProfile(spec, spec.runtimes[0]!)) as Record<string, any>;

    // serve_a2a gives AGENTCORE_RUNTIME_URL precedence, so localhost here would send clients that
    // read the card back to themselves.
    expect(profile.agent.env.AGENTCORE_RUNTIME_URL).toBe("${{ inputs.runtime.url }}");
  });

  test("runs agent-python-strands from the zip with the Runtime's Python, read through the packs", () => {
    const text = renderBoxProfile(
      "V3Demo",
      template("agent-python-strands-box"),
      "us-west-2",
      "runtime",
    )!;
    // No start.sh fills this profile in: the packs carry the deployed resources, Python, and code.
    expect(text).toContain("box/agentcore-codezip packs carry");
    expect(text).not.toContain("# @AGENT_ENV@");
    expect(parse(text)).toEqual({
      packs: ["box/base", "box/bedrock", "box/agentcore", "box/agentcore-codezip"],
      profile: { name: "V3Demo" },
      project: { access: "write" },
      options: { bedrock: { region: "us-west-2" } },
      agent: {
        command: [
          "${{ inputs.python.path }}",
          "-m",
          "uvicorn",
          "main:app",
          "--app-dir",
          "${{ inputs.code.dir }}",
          "--host",
          "127.0.0.1",
          "--port",
          "8081",
        ],
        env: {
          PORT: "8081",
          PYTHONPATH: "${{ inputs.code.dir }}/.box-dist/ffi:${{ inputs.code.dir }}",
          PYTHONUNBUFFERED: "1",
          PYTHONUTF8: "1",
          ...RUNTIME_AWS_STAND_INS,
          ...RUNTIME_REGION_WITH_BEDROCK,
        },
        filesystem: {
          read: ["${{ inputs.code.dir }}", "${{ inputs.python.prefix }}", "/usr/lib64", "/lib64"],
          exec: ["${{ inputs.code.dir }}", "${{ inputs.python.prefix }}"],
        },
        ingress: [{ listen: "0.0.0.0:8080", workload_port: 8081 }],
      },
    });
  });

  test.each(["agent-python-strands-box-container"] as const)(
    "runs %s from /app without --reload, signing calls with the Runtime's role",
    (name) => {
      const text = renderBoxProfile("V3Demo", template(name), "us-west-2", "runtime")!;
      // No start.sh fills this profile in: the agentcore pack carries the deployed resources.
      expect(text).toContain("The box/agentcore pack carries the deployed resources' variables.");
      expect(text).not.toContain("# @AGENT_ENV@");
      expect(runtimeProfile(name)).toEqual({
        // The container reads the deployed resources from the environment through box/agentcore.
        packs: ["box/base", "box/bedrock", "box/agentcore"],
        profile: { name: "V3Demo" },
        project: { access: "read" },
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
            ...RUNTIME_REGION_WITH_BEDROCK,
          },
          filesystem: IMAGE_PYTHON_FILESYSTEM,
          ingress: [{ listen: "0.0.0.0:8080", workload_port: 8081 }],
        },
      });
    },
  );

  test("serves the MCP server on all interfaces on the Runtime", () => {
    const mcp = runtimeProfile("mcp-python-fastmcp-box");
    expect(mcp.agent.ingress).toEqual([{ listen: "0.0.0.0:8000", workload_port: 8001 }]);
    // The template has no default Memory route; build and deploy add it when the project has one.
    expect(mcp.egress).toBeUndefined();
  });

  test("gives a non-Bedrock model no route, since its key comes from AgentCore Identity", () => {
    const openai = runtimeProfile("agent-python-strands-box", {
      modelProvider: "OpenAI",
      apiKey: "sk-test",
    });
    expect(openai.packs).toEqual(["box/base", "box/agentcore", "box/agentcore-codezip"]);
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
        url: `\${{ inputs.gateway.url }}/${target}`,
        // Signed for the Runtime's own region, which box reads from AWS_REGION there.
        auth: {
          ref: "aws://",
          aws: { service: "bedrock-agentcore", region: "${{ inputs.aws.region }}" },
        },
      },
    ],
  });

  test("signs a container's gateway route with a bare aws://, from the gateway URL input", () => {
    const container = spec([], { build: "Container", entrypoint: "main.py" }, [
      getBoxGatewayAgentCoreTargetSpec(),
    ]);
    expect(egressOf(container).agentcore as unknown).toEqual({
      destinations: ["bedrock-agentcore.us-west-2.amazonaws.com"],
      backends: [
        {
          // The gateway URL comes from the agentcore pack's input, not a start.sh placeholder.
          url: "${{ inputs.gateway.url }}/agentcore",
          auth: {
            ref: "aws://",
            aws: { service: "bedrock-agentcore", region: "${{ inputs.aws.region }}" },
          },
        },
      ],
    });
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

  test("signs each route for the gateway in the Runtime's own region", () => {
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
          url: "${{ inputs.gateway.url }}/bedrock",
          // The gateway is in the Runtime's region, which box reads from AWS_REGION there.
          auth: {
            ref: "aws://",
            aws: { service: "bedrock-agentcore", region: "${{ inputs.aws.region }}" },
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

  describe("for an HTTP MCP server", () => {
    const TOOLS = passthrough("egress-tools", "https://tools.example.com");
    const BACKENDS = gatewayRoute("egress-tools", "tools.example.com").backends;
    /** The model's host for the server `tools`, which the target `egress-tools` serves. */
    const toolsHost = (secret?: Record<string, string>) =>
      ({
        host: "tools.example.com",
        authority: "tools.example.com",
        sources: [
          {
            kind: "mcp",
            mcpEntry: "tools",
            destinations: ["tools.example.com"],
            ...(secret && { secret }),
          },
          { kind: "rule", ruleId: "mcp_tools_connect" },
        ],
        outboundAuth: { kind: "none" },
        reachable: true,
        target: "egress-tools",
        allowed: 3,
        samples: 3,
        forbiddenBy: [],
        enforcedByBox: [],
      }) as BoxNetworkHost;
    const rendered = (secret?: Record<string, string>) => {
      const project = spec([], {}, [TOOLS]);
      const text = renderRuntimeBoxProfile(project, project.runtimes[0]!, {
        policyFiles: [],
        hosts: [toolsHost(secret)],
      });
      return {
        text,
        toml: parse(text) as { egress?: Record<string, unknown>; mcp?: Record<string, unknown> },
      };
    };

    test("writes the server's target as the server, with its env:// secret, and no [egress] route", () => {
      const { text, toml } = rendered({
        ref: "env://TOOLS_TOKEN",
        header: "x-api-key",
        phantom_prefix: "tk-",
        inject: "always",
      });

      expect(toml.egress?.["egress-tools"]).toBeUndefined();
      expect(toml.mcp).toEqual({
        tools: {
          type: "http",
          destinations: ["tools.example.com"],
          // The agent keeps its stand-in; inject has no effect beside a backend, and Box refuses it.
          secret: { ref: "env://TOOLS_TOKEN", header: "x-api-key", phantom_prefix: "tk-" },
          backends: BACKENDS,
        },
      });
      expect(text).toContain(
        "\n# The MCP server 'tools' at tools.example.com, through the 'agent-box-egress' " +
          "gateway's 'egress-tools' target.\n" +
          '[mcp.tools]\ntype = "http"\ndestinations = ["tools.example.com"]\n' +
          'secret.ref = "env://TOOLS_TOKEN"\nsecret.header = "x-api-key"\n' +
          'secret.phantom_prefix = "tk-"\n\n' +
          "[[mcp.tools.backends]]\n" +
          'url = "${{ inputs.gateway.url }}/egress-tools"\nauth.ref = "aws://"\n' +
          'auth.aws.service = "bedrock-agentcore"\nauth.aws.region = "${{ inputs.aws.region }}"\n',
      );
    });

    test("keeps no secret of a server that signs, or has none, as Box refuses a signed one beside a backend", () => {
      for (const secret of [{ ref: "aws://default" }, undefined]) {
        expect(rendered(secret).toml.mcp).toEqual({
          tools: { type: "http", destinations: ["tools.example.com"], backends: BACKENDS },
        });
      }
    });

    test("writes a target that serves no server of the model as an [egress] route", () => {
      const project = spec([], {}, [TOOLS]);
      const toml = parse(renderRuntimeBoxProfile(project, project.runtimes[0]!)) as {
        egress: Record<string, unknown>;
        mcp?: unknown;
      };

      expect(toml.egress["egress-tools"]).toEqual(
        gatewayRoute("egress-tools", "tools.example.com"),
      );
      expect(toml.mcp).toBeUndefined();
    });
  });

  describe("for the [telemetry] of the box profile", () => {
    /** The resolved `[telemetry]` of a box profile with a target of each kind Box takes. */
    const TELEMETRY = {
      records: { kind: "file", destination: "/tmp/records.jsonl" },
      collector: { kind: "otlp", destination: "https://collector.example.com" },
      langfuse: { kind: "langfuse", secret: { ref: "env://LANGFUSE_AUTH" } },
      langsmith: { kind: "langsmith", secret: { ref: "env://LANGSMITH_KEY" } },
      logs: {
        kind: "cloudwatch_logs",
        region: "us-west-2",
        log_group: "/aws/box",
        log_stream: "agent",
        include: ["logs", "trace"],
        secret: { ref: "aws://Admin-personal" },
      },
      "x-ray": { kind: "cloudwatch_traces", region: "eu-west-1", secret: { ref: "aws://" } },
    };
    /** The Runtime profile when the model sets `region` on a target with none. */
    const rendered = (telemetry: Record<string, unknown>, region = "us-west-2") => {
      const project = spec([]);
      const text = renderRuntimeBoxProfile(project, project.runtimes[0]!, {
        policyFiles: [],
        telemetry: withDeployRegion(cloudWatchTelemetry({ telemetry }), region, "profile.toml")
          .telemetry,
      });
      return { text, toml: parse(text) as { telemetry?: Record<string, unknown> } };
    };

    test("copies each CloudWatch target with its keys, signed with the execution role", () => {
      const { text, toml } = rendered(TELEMETRY);

      expect(toml.telemetry).toEqual({
        logs: {
          kind: "cloudwatch_logs",
          region: "us-west-2",
          log_group: "/aws/box",
          log_stream: "agent",
          include: ["logs", "trace"],
          // On the Runtime, a bare aws:// is the default credential chain: the execution role.
          secret: { ref: "aws://" },
        },
        "x-ray": {
          kind: "cloudwatch_traces",
          region: "eu-west-1",
          secret: { ref: "aws://" },
        },
      });
      expect(text).toContain(
        "\n# The [telemetry.logs] target of .box/agent/local/profile.toml, signed with the " +
          "execution role.\n" +
          '[telemetry.logs]\nkind = "cloudwatch_logs"\nregion = "us-west-2"\n' +
          'log_group = "/aws/box"\nlog_stream = "agent"\ninclude = ["logs", "trace"]\n' +
          'secret.ref = "aws://"\n',
      );
      expect(text).not.toContain("Admin-personal");
    });

    test("copies no file, otlp, langfuse, or langsmith target", () => {
      const { records, collector, langfuse, langsmith } = TELEMETRY;

      expect(rendered({ records, collector, langfuse, langsmith }).toml.telemetry).toBeUndefined();
    });

    test("copies no CloudWatch target that Box refuses, as it grants it nothing", () => {
      const logs = { ...TELEMETRY.logs, log_stream: "a:b" };

      expect(
        rendered({ logs, traces: { ...TELEMETRY["x-ray"], include: [] } }).toml.telemetry,
      ).toBeUndefined();
    });

    test("writes the deploy region on a target with no region, and keeps a target's own region", () => {
      const { region: _region, ...logs } = TELEMETRY.logs;

      expect(rendered({ logs, "x-ray": TELEMETRY["x-ray"] }, "ap-south-1").toml.telemetry).toEqual({
        logs: { ...TELEMETRY.logs, region: "ap-south-1", secret: { ref: "aws://" } },
        "x-ray": {
          kind: "cloudwatch_traces",
          region: "eu-west-1",
          secret: { ref: "aws://" },
        },
      });
    });
  });

  test("renders the CodeZip form for start.py and the image form for a container", () => {
    const codeZip = spec(["agentMemory"]);
    const container = spec(["agentMemory"], { build: "Container", entrypoint: "main.py" });

    expect(renderRuntimeBoxProfile(codeZip, codeZip.runtimes[0]!)).toContain(
      '"${{ inputs.python.path }}"',
    );
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
  test("starts only the CodeZip box template in a box", () => {
    const plain = (name: RuntimeTemplateShortcutName) => resolveRuntimeTemplateShortcut(name);
    expect(startsInBoxOnCodeZip(plain("agent-python-strands-box"))).toBe(true);
    expect(startsInBoxOnCodeZip(plain("agent-python-minimal-box"))).toBe(true);
    expect(startsInBoxOnCodeZip(plain("agent-python-minimal"))).toBe(false);
    expect(startsInBoxOnCodeZip(plain("agent-python-langchain-box"))).toBe(true);
    expect(startsInBoxOnCodeZip(plain("agent-python-langchain"))).toBe(false);
    expect(startsInBoxOnCodeZip(plain("a2a-python-strands-box"))).toBe(true);
    expect(startsInBoxOnCodeZip(plain("a2a-python-strands"))).toBe(false);
    expect(startsInBoxOnCodeZip(plain("agui-python-strands-box"))).toBe(true);
    expect(startsInBoxOnCodeZip(plain("agui-python-strands"))).toBe(false);
    expect(startsInBoxOnCodeZip(plain("agent-python-strands"))).toBe(false);
    expect(startsInBoxOnCodeZip(plain("mcp-python-fastmcp"))).toBe(false);
    expect(startsInBoxOnCodeZip(plain("mcp-python-fastmcp-box"))).toBe(true);
    expect(startsInBoxOnCodeZip(plain("agent-python-strands-box-container"))).toBe(false);
    expect(startsInBoxOnCodeZip(plain("agent-typescript-strands"))).toBe(false);
  });
});

describe("renderAgentCorePack", () => {
  function pack(memories: { name: string }[]) {
    return parse(
      renderAgentCorePack({ name: "V3Demo", memories } as unknown as ProjectSpec),
    ) as Record<string, any>;
  }

  test("names itself box/agentcore and ships as a support pack", () => {
    const toml = pack([]);
    expect(toml.pack).toEqual({ name: "box/agentcore", version: 1, kind: "support" });
  });

  test("declares the gateway URL input from the environment, bounded by a pattern", () => {
    const { inputs } = pack([]);
    expect(inputs.gateway.url.from).toBe("env:AGENTCORE_GATEWAY_BOX_URL");
  });

  const GATEWAY =
    "https://agent-box-egress-abc123.gateway.bedrock-agentcore.us-west-2.amazonaws.com";

  test.each([GATEWAY, `${GATEWAY}/mcp`])("the gateway URL pattern matches %s", (url) => {
    // The CDK sets the URL with /mcp; box refuses the profile if the pattern does not match it.
    expect(new RegExp(`^${pack([]).inputs.gateway.url.pattern}$`).test(url)).toBe(true);
  });

  test.each([
    "http://agent.gateway.bedrock-agentcore.us-west-2.amazonaws.com",
    "https://evil.example.com",
    "https://agent.amazonaws.com.evil.example.com",
    "https://agent.amazonaws.com/../x",
    "https://agent.amazonaws.com/mcp?x=1",
  ])("the gateway URL pattern refuses %s", (url) => {
    expect(new RegExp(`^${pack([]).inputs.gateway.url.pattern}$`).test(url)).toBe(false);
  });

  test("declares the Runtime's region input from AWS_REGION, bounded by a pattern", () => {
    const { inputs } = pack([]);
    expect(inputs.aws.region.from).toBe("env:AWS_REGION");
    expect(new RegExp(`^${inputs.aws.region.pattern}$`).test("eu-central-1")).toBe(true);
    expect(new RegExp(`^${inputs.aws.region.pattern}$`).test("us-gov-west-1")).toBe(true);
    expect(new RegExp(`^${inputs.aws.region.pattern}$`).test("us-west-2; rm")).toBe(false);
  });

  test("declares the A2A card URL input from the Runtime's AGENTCORE_RUNTIME_URL", () => {
    const { inputs } = pack([]);
    expect(inputs.runtime.url.from).toBe("env:AGENTCORE_RUNTIME_URL");
    // What serve_a2a advertises outside a box when the Runtime sets none.
    expect(inputs.runtime.url.default).toBe("http://localhost:9000/");
  });

  test("declares one input per memory and carries each ID into the agent's environment", () => {
    const toml = pack([{ name: "agentMemory" }, { name: "notes" }]);
    expect(toml.inputs.memory.agentMemory.id.from).toBe("env:MEMORY_AGENTMEMORY_ID");
    expect(toml.inputs.memory.notes.id.from).toBe("env:MEMORY_NOTES_ID");
    expect(toml.agent.env).toEqual({
      MEMORY_AGENTMEMORY_ID: "${{ inputs.memory.agentMemory.id }}",
      MEMORY_NOTES_ID: "${{ inputs.memory.notes.id }}",
    });
  });

  test("has no agent.env when the project has no memory", () => {
    expect(pack([]).agent).toBeUndefined();
  });
});

describe("renderAgentCoreCodeZipPack", () => {
  const toml = () => parse(renderAgentCoreCodeZipPack()) as Record<string, any>;

  test("names itself box/agentcore-codezip and ships as a support pack", () => {
    expect(toml().pack).toEqual({ name: "box/agentcore-codezip", version: 1, kind: "support" });
  });

  test("declares the Runtime Python and code directory from the environment start.py exports", () => {
    const { inputs } = toml();
    expect(inputs.python.path.from).toBe("env:BOX_PYTHON");
    expect(inputs.python.prefix.from).toBe("env:BOX_PYTHON_PREFIX");
    expect(inputs.code.dir.from).toBe("env:BOX_CODE");
  });

  test("bounds the inputs that reach the agent command or a filesystem grant with a pattern", () => {
    const { inputs } = toml();
    // The Python path (command element 0) and the code dir (--app-dir) reach `command`; the prefix
    // reaches the read and exec grants.
    for (const input of [inputs.python.path, inputs.code.dir, inputs.python.prefix]) {
      const pattern = new RegExp(`^${input.pattern}$`);
      expect(pattern.test("/var/lang")).toBe(true);
      // Neither an empty value nor / may widen a grant to the whole filesystem.
      expect(pattern.test("")).toBe(false);
      expect(pattern.test("/")).toBe(false);
      // No . or .. segment, which would resolve to / in a grant.
      for (const path of ["/.", "/..", "/var/lang/../..", "/var/./lang", "/var/lang/"]) {
        expect(pattern.test(path)).toBe(false);
      }
      for (const path of ["/opt/python3.12", "/var/task/.venv", "/tmp/..x"]) {
        expect(pattern.test(path)).toBe(true);
      }
      expect(pattern.test("/opt/x --reload")).toBe(false);
    }
  });
});
