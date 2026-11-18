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
  boxProfileWarnings,
  hasBoxProfile,
  renderAgentCoreCodeZipPack,
  renderAgentCorePack,
  renderBoxProfile,
  renderRuntimeBoxProfile,
  runsBoxStartScript,
  startsInBoxOnCodeZip,
} from "./boxProfile";

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
  policies?: string[];
  profile: { name: string };
  options?: { bedrock?: { region?: string } };
  agent: {
    command: string[];
    env: Record<string, string>;
    filesystem: { read: unknown[]; exec: unknown[]; deny_write?: unknown[] };
    ingress: { listen: string; workload_port: number }[];
  };
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

  test("names itself after the project, so `box run box/agent/local/profile.toml` can load it by its path", () => {
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
    expect(
      boxProfileWarnings(template("agent-python-strands", { modelProvider: "LiteLLM" })),
    ).toEqual([]);
  });

  test("calls Bedrock in the region create resolved", () => {
    const text = renderBoxProfile("V3Demo", STRANDS, "local", "", [], "eu-west-1")!;
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
        "section with its provider's host to box/agent/local/profile.toml, or the box blocks the agent's " +
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

function runtimeProfile(name: RuntimeTemplateShortcutName, overrides: Record<string, string> = {}) {
  const text = renderBoxProfile("V3Demo", template(name, overrides), "runtime")!;
  return parse(text) as unknown as BoxProfile;
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

/** The fake AWS keys a Runtime profile gives the agent, so boto3 in the box builds its requests. */
const AWS_STAND_INS = { AWS_ACCESS_KEY_ID: "box-stand-in", AWS_SECRET_ACCESS_KEY: "box-stand-in" };

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

  test("runs agent-python-strands from the zip with the Runtime's Python, read through the packs", () => {
    const text = renderBoxProfile("V3Demo", template("agent-python-strands"), "runtime")!;
    // No start.sh fills this profile in: the packs carry the deployed resources, Python, and code.
    expect(text).toContain("box/agentcore-codezip packs carry");
    expect(text).not.toContain("# @AGENT_ENV@");
    expect(parse(text)).toEqual({
      packs: ["box/base", "box/bedrock", "box/agentcore", "box/agentcore-codezip"],
      profile: { name: "V3Demo" },
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
          ...AWS_STAND_INS,
        },
        filesystem: {
          read: ["${{ inputs.code.dir }}", "${{ inputs.python.prefix }}", "/usr/lib64", "/lib64"],
          exec: ["${{ inputs.code.dir }}", "${{ inputs.python.prefix }}"],
        },
        ingress: [{ listen: "0.0.0.0:8080", workload_port: 8081 }],
      },
    });
  });

  test.each(["agent-python-strands-container"] as const)(
    "runs %s from /app without --reload, signing calls with the Runtime's role",
    (name) => {
      const text = renderBoxProfile("V3Demo", template(name), "runtime")!;
      // No start.sh fills this profile in: the agentcore pack carries the deployed resources.
      expect(text).toContain("The box/agentcore pack carries the deployed resources' variables.");
      expect(text).not.toContain("# @AGENT_ENV@");
      expect(runtimeProfile(name)).toEqual({
        // The container reads the deployed resources from the environment through box/agentcore.
        packs: ["box/base", "box/bedrock", "box/agentcore"],
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
          env: { PORT: "8081", PYTHONUNBUFFERED: "1", PYTHONUTF8: "1", ...AWS_STAND_INS },
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
    expect(openai.packs).toEqual(["box/base", "box/agentcore", "box/agentcore-codezip"]);
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
        // Both Runtime profiles read the gateway URL from the environment through the agentcore pack.
        expect(route.backends?.map(({ url }) => url)).toEqual([
          `\${{ inputs.gateway.url }}/${name}`,
        ]);
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
          // The gateway URL comes from the agentcore pack's input, not a start.sh placeholder.
          url: "${{ inputs.gateway.url }}/github",
          // A bare aws:// signs with the execution role via the default credential chain.
          auth: {
            ref: "aws://",
            aws: { service: "bedrock-agentcore", region: "us-west-2" },
          },
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
          url: "${{ inputs.gateway.url }}/agentcore",
          auth: {
            ref: "aws://",
            aws: { service: "bedrock-agentcore", region: "us-west-2" },
          },
        },
      ],
    });
  });

  test("names the model's policy files under policies, at the top of the profile", () => {
    const project = spec([bedrock]);
    const text = renderRuntimeBoxProfile(project, project.runtimes[0]!, {
      policyFiles: ["policy.dw", "rules/extra.dw"],
    });

    expect(parse(text).policies).toEqual(["policy.dw", "rules/extra.dw"]);
    expect(text).toContain('policies = ["policy.dw", "rules/extra.dw"]\n');
    expect(parse(renderRuntimeBoxProfile(project, project.runtimes[0]!)).policies).toBeUndefined();
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

    expect(renderRuntimeBoxProfile(codeZip, codeZip.runtimes[0]!)).toContain(
      '"${{ inputs.python.path }}"',
    );
    expect(renderRuntimeBoxProfile(container, container.runtimes[0]!)).toContain(
      '"${{ workspace }}/.venv/bin/python"',
    );
  });

  describe("with instrumentation.enableOtel", () => {
    const CODEZIP = { build: "CodeZip", entrypoint: "start.py" } as const;
    const CONTAINER = { build: "Container", entrypoint: "main.py" } as const;

    /** The agent the CodeZip profile starts: the Runtime's Python serving the zip's code. */
    const CODEZIP_AGENT = [
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
    ];
    /** The agent the container profile starts: the image venv's Python serving /app. */
    const CONTAINER_AGENT = [
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
    ];
    /** Where deploy packages opentelemetry-instrument in the zip, and where uv installs it in the image. */
    const ZIP_INSTRUMENT = "${{ inputs.code.dir }}/bin/opentelemetry-instrument";
    const IMAGE_INSTRUMENT = "${{ workspace }}/.venv/bin/opentelemetry-instrument";

    const INSTRUMENTED = [
      // The zip's script starts `#!/usr/bin/env python3`, so the Runtime's Python runs it.
      ["CodeZip", CODEZIP, ["${{ inputs.python.path }}", ZIP_INSTRUMENT, ...CODEZIP_AGENT]],
      // As the plain template's CMD runs it, with the venv's Python named by its path.
      ["container", CONTAINER, [IMAGE_INSTRUMENT, ...CONTAINER_AGENT]],
    ] as const;

    function agentOf(runtime: Partial<ProjectRuntime>) {
      const project = spec([bedrock], runtime);
      return (parse(renderRuntimeBoxProfile(project, project.runtimes[0]!)) as BoxProfile).agent;
    }

    test.each(INSTRUMENTED)(
      "starts the %s agent under opentelemetry-instrument when agentcore.json leaves it unset",
      (_, runtime, command) => {
        expect(agentOf(runtime).command).toEqual([...command]);
      },
    );

    test.each(INSTRUMENTED)(
      "starts the %s agent under opentelemetry-instrument when it is true",
      (_, runtime, command) => {
        const agent = agentOf({ ...runtime, instrumentation: { enableOtel: true } });
        expect(agent.command).toEqual([...command]);
      },
    );

    test.each([
      ["CodeZip", CODEZIP, CODEZIP_AGENT],
      ["container", CONTAINER, CONTAINER_AGENT],
    ] as const)("starts the %s agent itself when it is false", (_, runtime, command) => {
      const agent = agentOf({ ...runtime, instrumentation: { enableOtel: false } });
      expect(agent.command).toEqual([...command]);
    });

    test("wraps a CodeZip agent that runs as a module the same way", () => {
      expect(agentOf({ ...CODEZIP, protocol: "A2A" }).command).toEqual([
        "${{ inputs.python.path }}",
        ZIP_INSTRUMENT,
        "${{ inputs.python.path }}",
        "-m",
        "main",
      ]);
    });

    /** Whether an entry of `grants` is `path` or a folder above it. */
    function covers(grants: unknown[], path: string): boolean {
      return grants.some((grant) => {
        const granted = typeof grant === "string" ? grant : (grant as { path: string }).path;
        return path === granted || path.startsWith(`${granted}/`);
      });
    }

    test.each([
      ["CodeZip", CODEZIP],
      ["container", CONTAINER],
    ] as const)("adds no filesystem grant to the %s profile", (_, runtime) => {
      const on = agentOf(runtime).filesystem;
      const off = agentOf({ ...runtime, instrumentation: { enableOtel: false } }).filesystem;
      expect(on).toEqual(off);
      // What running the zip's `#!/usr/bin/env python3` script directly would need.
      expect(covers(on.exec, "/usr/bin/env")).toBe(false);
    });

    test("reads the zip's opentelemetry-instrument through the code directory's grant", () => {
      expect(covers(agentOf(CODEZIP).filesystem.read, ZIP_INSTRUMENT)).toBe(true);
    });

    test("runs the image's opentelemetry-instrument and its shebang's Python through the venv's grant", () => {
      const { read, exec } = agentOf(CONTAINER).filesystem;
      expect(covers(read, IMAGE_INSTRUMENT)).toBe(true);
      expect(covers(exec, IMAGE_INSTRUMENT)).toBe(true);
      expect(covers(exec, "${{ workspace }}/.venv/bin/python")).toBe(true);
    });
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

  test("recognizes the start script with or without a handler", () => {
    expect(runsBoxStartScript("start.py")).toBe(true);
    expect(runsBoxStartScript("start.py:app")).toBe(true);
    expect(runsBoxStartScript("main.py")).toBe(false);
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
    // The input reaches a backend url, so box needs a pattern or values on it.
    expect(typeof inputs.gateway.url.pattern).toBe("string");
    expect(inputs.gateway.url.pattern.length).toBeGreaterThan(0);
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

  test("bounds the inputs that reach the agent command with a pattern", () => {
    const { inputs } = toml();
    // The Python path (command element 0) and the code dir (--app-dir) reach `command`.
    expect(typeof inputs.python.path.pattern).toBe("string");
    expect(typeof inputs.code.dir.pattern).toBe("string");
    // The prefix reaches only filesystem grants, which box does not require to be bounded.
    expect(inputs.python.prefix.pattern).toBeUndefined();
  });
});
