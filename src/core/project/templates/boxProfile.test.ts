import { describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
import {
  resolveRuntimeTemplateShortcut,
  type RuntimeTemplateShortcutName,
} from "../../../handlers/project/shortcuts";
import type { ModelProvider } from "../../../handlers/project/types";
import { type ProjectSpec } from "../../../projectSchemas/project";
import {
  boxProfileWarnings,
  boxStartFolder,
  hasBoxProfile,
  renderAgentCoreCodeZipPack,
  renderAgentCorePack,
  renderBoxProfile,
  runtimeAgentTemplate,
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
      packs: ["@box/base", "@box/bedrock"],
      profile: { name: "V3Demo-agent" },
      project: { access: "write" },
      options: { bedrock: { region: "us-west-2" } },
      agent: {
        command: UVICORN,
        env: { LOCAL_DEV: "1", PORT: "8081", PYTHONUNBUFFERED: "1", PYTHONUTF8: "1" },
        filesystem: VENV_GRANTS,
        ingress: [{ listen: "127.0.0.1:8080", workload_port: 8081 }],
      },
      egress: { bedrock: { secret: { ref: "aws://" } } },
    });
  });

  test("names itself after the project and the runtime, and the folder `agentcore dev` starts box in", () => {
    // box keeps one profile of each name on a machine, and each runtime has its own local profile.
    expect(profile("agent-python-minimal-box").profile).toEqual({ name: "V3Demo-agent" });
    const text = renderBoxProfile("V3Demo", STRANDS)!;
    expect(text).toContain("runs `box run ../../.box/agent/local/profile.toml` there");
  });

  // The folder comes from agentcore.json, never from the profile, which a user may edit.
  test("starts a CodeZip runtime's box in its code folder, and a container's in the project root", () => {
    expect(boxStartFolder({ build: "CodeZip", codeLocation: "app/agent/" })).toBe("app/agent");
    expect(boxStartFolder({ build: "CodeZip", codeLocation: "./app/agent" })).toBe("app/agent");
    // A container profile describes the image's /app.
    expect(boxStartFolder({ build: "Container", codeLocation: "app/agent" })).toBe("");
  });

  // agentcore dev starts box in app/<runtime>, so ${{ workspace }} and the project grant are that
  // folder: agentcore/.env.local, with the model's key, .git and agentcore/cdk lie outside them.
  test("grants the agent its own folder and no other folder of the project", () => {
    const { project, agent } = profile("agent-python-strands-box", {
      modelProvider: "OpenAI",
      apiKey: "sk-test",
    });
    expect(project).toEqual({ access: "write" });
    for (const grant of [...agent.filesystem.read, ...agent.filesystem.exec]) {
      const path = typeof grant === "string" ? grant : grant.path;
      expect(path).not.toMatch(/agentcore|\.git|\.\./);
    }
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
      expect(packs).toEqual(["@box/base", "@box/bedrock"]);
      expect(agent.command).toEqual(UVICORN);
      expect(agent.filesystem).toEqual(VENV_GRANTS);
      expect(egress.bedrock).toEqual({ secret: { ref: "aws://" } });
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
    expect(mcp.packs).toEqual(["@box/base"]);
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
      expect(packs).toEqual(["@box/base"]);
      expect(options).toBeUndefined();
      expect(egress).toEqual({ [route]: expected });
    },
  );

  test("routes a LiteLLM agent on a bedrock/ model through Bedrock", () => {
    const { packs, egress } = profile("agent-python-strands-box", { modelProvider: "LiteLLM" });
    expect(packs).toEqual(["@box/base", "@box/bedrock"]);
    expect(egress).toEqual({ bedrock: { secret: { ref: "aws://" } } });
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

describe("runtimeAgentTemplate", () => {
  test("gives a CodeZip template's [agent] on the Runtime in the local paths, with no reload", () => {
    expect(runtimeAgentTemplate(STRANDS)).toEqual({
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
      env: { PORT: "8081", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" },
      filesystem: {
        read: ["${{ workspace }}", "${{ home }}/.local/share/uv/python", "/usr/lib64", "/lib64"],
        exec: ["${{ workspace }}", "${{ home }}/.local/share/uv/python"],
      },
      ingress: [{ listen: "0.0.0.0:8080", workload_port: 8081 }],
    });
  });

  test("gives the container template's [agent] on the Runtime, which keeps the image's paths", () => {
    const agent = runtimeAgentTemplate(template("agent-python-strands-box-container"))!;
    const local = profile("agent-python-strands-box-container").agent;

    expect(agent.command).toEqual([
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
    ]);
    expect(local.command).toContain("--reload");
    expect(agent.env).toEqual({ PORT: "8081", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" });
    expect(agent.filesystem).toEqual(local.filesystem);
    expect(agent.ingress).toEqual(local.ingress);
  });

  test("gives no [agent] for a template that is not a box template", () => {
    expect(runtimeAgentTemplate(resolveRuntimeTemplateShortcut("agent-python-strands"))).toBe(
      undefined,
    );
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
  /** The pack of a runtime with OTEL off unless `otel`. */
  function pack(memories: { name: string }[], otel = false) {
    return parse(
      renderAgentCorePack({ name: "V3Demo", memories } as unknown as ProjectSpec, {
        name: "agent",
        ...(!otel && { instrumentation: { enableOtel: false } }),
      }),
    ) as Record<string, any>;
  }

  test("names itself @box/agentcore and ships as a support pack", () => {
    const toml = pack([]);
    expect(toml.pack).toEqual({ name: "@box/agentcore", version: 1, kind: "support" });
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

  test("declares the runtime's log group and log stream inputs as keys of OTEL_EXPORTER_OTLP_LOGS_HEADERS", () => {
    const { inputs } = pack([]);
    expect(inputs.runtime.log_group).toEqual({
      description: "The runtime's own CloudWatch Logs log group.",
      from: "env:OTEL_EXPORTER_OTLP_LOGS_HEADERS",
      key: "x-aws-log-group",
    });
    expect(inputs.runtime.log_stream).toEqual({
      description: "The runtime's own CloudWatch Logs log stream.",
      from: "env:OTEL_EXPORTER_OTLP_LOGS_HEADERS",
      key: "x-aws-log-stream",
    });
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

  test("has no agent.env when the project has no memory and OTEL is off", () => {
    expect(pack([]).agent).toBeUndefined();
    expect(pack([]).inputs.runtime).not.toHaveProperty("resource_attributes");
  });

  test("with OTEL on, sets up the agent's ADOT SDK and sets no OTEL_EXPORTER_OTLP_ variable, which box owns", () => {
    const { env } = pack([{ name: "agentMemory" }], true).agent;

    expect(env).toEqual({
      MEMORY_AGENTMEMORY_ID: "${{ inputs.memory.agentMemory.id }}",
      OTEL_PYTHON_DISTRO: "aws_distro",
      OTEL_PYTHON_CONFIGURATOR: "aws_configurator",
      AGENT_OBSERVABILITY_ENABLED: "true",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_METRICS_EXPORTER: "none",
      OTEL_PYTHON_EXCLUDED_URLS: "/ping",
      OTEL_RESOURCE_ATTRIBUTES: "${{ inputs.runtime.resource_attributes }}",
    });
    expect(Object.keys(env).filter((name) => name.startsWith("OTEL_EXPORTER_OTLP_"))).toEqual([]);
  });

  test("with OTEL on, reads the Runtime's OTEL_RESOURCE_ATTRIBUTES, with the runtime's name when the Runtime sets none", () => {
    expect(pack([], true).inputs.runtime.resource_attributes).toEqual({
      description: "The OpenTelemetry resource attributes of the runtime.",
      from: "env:OTEL_RESOURCE_ATTRIBUTES",
      default: "service.name=agent",
    });
  });

  test("gives the agent no ADOT variable and declares no resource attributes input when the envVars set DISABLE_ADOT_OBSERVABILITY to true", () => {
    const spec = { name: "V3Demo" } as unknown as ProjectSpec;
    const optedOut = renderAgentCorePack(spec, {
      name: "agent",
      envVars: [{ name: "DISABLE_ADOT_OBSERVABILITY", value: "true" }],
    });

    expect(optedOut).toBe(
      renderAgentCorePack(spec, { name: "agent", instrumentation: { enableOtel: false } }),
    );
  });

  test("turns OTEL on when the runtime has no instrumentation, as create writes it", () => {
    const text = renderAgentCorePack({ name: "V3Demo" } as unknown as ProjectSpec, {
      name: "agent",
    });

    expect(text).toBe(
      renderAgentCorePack({ name: "V3Demo" } as unknown as ProjectSpec, {
        name: "agent",
        instrumentation: { enableOtel: true },
      }),
    );
    expect(text).toContain('OTEL_PYTHON_DISTRO = "aws_distro"');
  });
});

describe("renderAgentCoreCodeZipPack", () => {
  const toml = () => parse(renderAgentCoreCodeZipPack()) as Record<string, any>;

  test("names itself @box/agentcore-codezip and ships as a support pack", () => {
    expect(toml().pack).toEqual({ name: "@box/agentcore-codezip", version: 1, kind: "support" });
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
