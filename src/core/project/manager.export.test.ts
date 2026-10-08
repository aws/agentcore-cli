import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import z from "zod";
import { parse, stringify } from "yaml";
import { FsProjectManager } from "./manager";
import { FsReadWriteJson, type ReadWriteJson } from "../../io";
import { createSilentLogger, TestIdentityClient } from "../../testing";
import { resolveRuntimeTemplateShortcut } from "../../handlers/project/shortcuts";
import type { ExportHarnessInput, Project, ProjectEvent } from "../../handlers/project/types";
import { HarnessSpecSchema } from "../../projectSchemas/harness";

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-export-manager-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function manager(options: { json?: ReadWriteJson } = {}) {
  const commands: { command: string[]; cwd: string }[] = [];
  return {
    manager: new FsProjectManager({
      logger: createSilentLogger(),
      identity: new TestIdentityClient(),
      enableTransactionSearch: async () => {},
      json: options.json,
      runner: async (command, { cwd }) => {
        commands.push({ command, cwd });
      },
      checkTool: async () => {},
    }),
    commands,
  };
}

async function drain<T>(generator: AsyncGenerator<ProjectEvent, T>): Promise<T> {
  let next = await generator.next();
  while (!next.done) next = await generator.next();
  return next.value;
}

/** Creates a project with a harness built from `harness` overrides; returns the refreshed project. */
async function projectWithHarness(
  subject: FsProjectManager,
  harness: Record<string, unknown> = {},
): Promise<Project> {
  await inTempDirectory();
  let project = await drain(
    subject.create({
      name: "orders",
      skipInstall: true,
      skipGit: true,
      scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("agent-python-minimal"),
    }),
  );
  project = await drain(
    subject.addResource(project, {
      resourceType: "harness",
      resourceConfig: {
        name: "assistant",
        model: { provider: "bedrock", modelId: "us.amazon.nova-lite-v1:0" },
        systemPrompt: "You are a terse assistant.",
        memory: { mode: "disabled" },
        ...harness,
      } as z.input<typeof HarnessSpecSchema>,
    }),
  );
  return project;
}

function exportInput(overrides: Partial<ExportHarnessInput> = {}): ExportHarnessInput {
  return { harnessName: "assistant", targetAgentName: "assistantAgent", ...overrides };
}

describe("FsProjectManager.exportHarness rendered tree", () => {
  test("an exported harness retains the SDK Strands integration", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);

    const result = await drain(subject.exportHarness(project, exportInput()));

    const pyproject = await Bun.file(join(result.agentPath, "pyproject.toml")).text();
    expect(pyproject).toContain('"bedrock-agentcore[strands-agents] >= 1.18.1, < 2.0.0"');
  });

  test("builds the agent with create_harness and the builtin tools and plugins", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);
    // A service harness that sets no prompt or truncation, so the harness defaults apply.
    const spec = HarnessSpecSchema.parse({
      name: "remote",
      model: { provider: "bedrock", modelId: "global.anthropic.claude-opus-5-5" },
    });

    const result = await drain(
      subject.exportHarness(project, { prefetched: { spec }, targetAgentName: "remoteAgent" }),
    );

    const main = await Bun.file(join(result.agentPath, "main.py")).text();
    expect(main).toContain("cache[session_id] = build_session_agent(");
    expect(main).toContain("from strands_harness.tools import read, write, edit");
    expect(main).toContain('tools.append(make_web_fetch(mode="markdown"))');
    // No prompt set: create_harness applies the contract prompt.
    expect(main).not.toContain("system_prompt=");
    expect(main).toContain("SummarizingConversationManager(**");
    const runtime = await Bun.file(join(result.agentPath, "harness_runtime.py")).text();
    expect(runtime).toContain("from strands_harness import create_harness");
    expect(runtime).toContain(
      '_PLUGIN_TOOL_NAMES = frozenset(["todo_write","retrieve_offloaded_content"])',
    );
    expect(runtime).toContain("evict_after_cycles=None");
    expect(runtime).toContain("def _add_subagent_tool(");
    const loadModel = await Bun.file(join(result.agentPath, "model", "load.py")).text();
    expect(loadModel).toContain(
      'cache_config=CacheConfig(strategy="auto", system_prompt_ttl=True, tools_ttl=True)',
    );
    const pyproject = await Bun.file(join(result.agentPath, "pyproject.toml")).text();
    expect(pyproject).toContain('"strands-agents[web-fetch] ~= 1.57.1"');
    expect(pyproject).toContain('"strands-harness == 0.1.2"');
  });

  test("renders only the builtins and plugins allowedTools selects", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, { allowedTools: ["shell", "read"] });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const main = await Bun.file(join(result.agentPath, "main.py")).text();
    expect(main).toContain("system_prompt=DEFAULT_SYSTEM_PROMPT,");
    expect(main).toContain("from strands_harness.tools import read\n");
    expect(main).not.toContain("make_web_fetch");
    const runtime = await Bun.file(join(result.agentPath, "harness_runtime.py")).text();
    expect(runtime).toContain("_PLUGIN_TOOL_NAMES = frozenset([])");
    expect(runtime).not.toContain("make_subagent");
    expect(runtime).not.toContain("ContextOffloader");
    const pyproject = await Bun.file(join(result.agentPath, "pyproject.toml")).text();
    expect(pyproject).toContain('"strands-agents ~= 1.57.1"');
  });

  test("reports usage per model call unless a subagent can add to it", async () => {
    const { manager: subject } = manager();
    const render = async (allowedTools: string[]) => {
      const project = await projectWithHarness(subject, { allowedTools });
      const result = await drain(subject.exportHarness(project, exportInput()));
      return Bun.file(join(result.agentPath, "main.py")).text();
    };

    const withSubagent = await render(["subagent"]);
    expect(withSubagent).toContain("metadata = budget.metadata_event()");
    const without = await render(["shell"]);
    expect(without).not.toContain("budget.metadata_event()");
    expect(without).toMatch(/if "metadata" in event\["event"\]:\n\s+yield event/);
  });

  test("renders a subagent with no builtin tools to inherit", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, { allowedTools: ["subagent"] });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const runtime = await Bun.file(join(result.agentPath, "harness_runtime.py")).text();
    expect(runtime).toContain("_SUBAGENT_BUILTIN_TOOL_NAMES = frozenset([])");
    const main = await Bun.file(join(result.agentPath, "main.py")).text();
    expect(main).not.toContain("# Built-in tools");
    expect(main).not.toContain("from strands_harness.tools import");
  });

  test("prefixes MCP tools with their server name", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      tools: [
        {
          type: "remote_mcp",
          name: "exa",
          config: { remoteMcp: { url: "https://mcp.exa.ai/mcp" } },
        },
      ],
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const client = await Bun.file(join(result.agentPath, "mcp_client", "client.py")).text();
    expect(client).toContain('prefix="exa"');
  });

  test("counts an inline function turn's usage when handing the call off", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      tools: [
        {
          type: "inline_function",
          name: "lookup",
          config: { inlineFunction: { description: "d", inputSchema: { type: "object" } } },
        },
      ],
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const main = await Bun.file(join(result.agentPath, "main.py")).text();
    expect(main).toContain('budget.after_model_call(event["event"]["metadata"])');
  });

  test("loads only the MCP tools allowedTools selects", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      allowedTools: ["@exa/web_*"],
      tools: [
        {
          type: "remote_mcp",
          name: "exa",
          config: { remoteMcp: { url: "https://mcp.exa.ai/mcp" } },
        },
      ],
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const client = await Bun.file(join(result.agentPath, "mcp_client", "client.py")).text();
    expect(client).toContain('tool_filters=_allowed_tools("exa", "web_*")');
  });

  test("merges service model parameters under the explicit settings", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);
    const spec = HarnessSpecSchema.parse({
      name: "remote",
      model: { provider: "bedrock", modelId: "us.amazon.nova-lite-v1:0", temperature: 0.2 },
    });

    const result = await drain(
      subject.exportHarness(project, {
        prefetched: { spec, modelAdditionalParams: { top_k: 5 } },
        targetAgentName: "remoteAgent",
      }),
    );

    const loadModel = await Bun.file(join(result.agentPath, "model", "load.py")).text();
    expect(loadModel).toContain("additional_args=json.loads(");
    expect(loadModel).toContain("top_k");
  });

  test("enforces limits with one budget shared by the agent and its subagents", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      maxIterations: 3,
      maxTokens: 128,
      timeoutSeconds: 5,
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    expect(existsSync(join(result.agentPath, "hooks"))).toBe(false);
    const runtime = await Bun.file(join(result.agentPath, "harness_runtime.py")).text();
    expect(runtime).toContain("if self.iterations > 3:");
    expect(runtime).toContain('if self.usage["outputTokens"] >= 128:');
    expect(runtime).toContain('LimitExceeded("max_iterations_exceeded")');
    expect(runtime).toContain('LimitExceeded("max_output_tokens_exceeded")');
    const main = await Bun.file(join(result.agentPath, "main.py")).text();
    // The budget reaches subagents through the invocation state.
    expect(main).toContain('invocation_state={"budget": budget}');
    expect(main).toContain("cancel_signal = threading.Event()");
    expect(main).not.toContain("limits=");
  });

  test("leaves hooks/ and memory/ out of a plain export", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);

    const result = await drain(subject.exportHarness(project, exportInput()));

    expect(existsSync(join(result.agentPath, "hooks"))).toBe(false);
    expect(existsSync(join(result.agentPath, "memory"))).toBe(false);
    expect(existsSync(join(result.agentPath, "Dockerfile"))).toBe(false);
  });

  test("wires an in-project memory through memory/session.py", async () => {
    const { manager: subject } = manager();
    let project = await projectWithHarness(subject, {
      memory: { mode: "existing", name: "chat_history" },
    });
    project = await drain(
      subject.addResource(project, {
        resourceType: "memory",
        resourceConfig: {
          name: "chat_history",
          eventExpiryDuration: 30,
          strategies: [{ type: "SEMANTIC" }],
        },
      }),
    );

    const result = await drain(subject.exportHarness(project, exportInput()));

    const session = await Bun.file(join(result.agentPath, "memory", "session.py")).text();
    expect(session).toContain('MEMORY_ID = os.getenv("AGENTCORE_MEMORY_CHAT_HISTORY_ID")');
    expect(await Bun.file(join(result.agentPath, "main.py")).text()).toContain(
      "from memory.session import get_memory_session_manager",
    );
    expect(result.notes).toEqual([]);
  });

  test("renders memory retrieval tuning and notes messagesCount", async () => {
    const { manager: subject } = manager();
    let project = await projectWithHarness(subject, {
      memory: {
        mode: "existing",
        name: "chat_history",
        messagesCount: 12,
        retrievalConfig: { topK: 8, relevanceScore: 0.7 },
      },
    });
    project = await drain(
      subject.addResource(project, {
        resourceType: "memory",
        resourceConfig: {
          name: "chat_history",
          eventExpiryDuration: 30,
          strategies: [{ type: "SEMANTIC" }],
        },
      }),
    );

    const result = await drain(subject.exportHarness(project, exportInput()));

    const session = await Bun.file(join(result.agentPath, "memory", "session.py")).text();
    expect(session).toContain("RetrievalConfig(top_k=8, relevance_score=0.7)");
    expect(result.notes.map((note) => note.category)).toContain(
      "Memory messagesCount is not directly portable to Strands",
    );
  });

  test("renders OpenAI Responses settings with compatible Strands extras", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      model: {
        provider: "open_ai",
        modelId: "gpt-4.1",
        apiKeyArn:
          "arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default/apikeycredentialprovider/OpenAiKey",
        apiFormat: "responses",
        maxTokens: 512,
        temperature: 0.2,
        topP: 0.8,
      },
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const loadModel = await Bun.file(join(result.agentPath, "model", "load.py")).text();
    expect(loadModel).toContain("from strands.models.openai_responses import OpenAIResponsesModel");
    expect(loadModel).toContain(
      'IDENTITY_PROVIDER_NAME = os.environ.get("AGENTCORE_CREDENTIAL_OPENAIKEY_NAME", "OpenAiKey")',
    );
    expect(loadModel).toContain('params["max_output_tokens"] = 512');
    expect(loadModel).toContain('params["temperature"] = 0.2');
    expect(loadModel).toContain('params["top_p"] = 0.8');
    const pyproject = await Bun.file(join(result.agentPath, "pyproject.toml")).text();
    expect(pyproject).toContain('"strands-agents[openai,web-fetch] ~= 1.57.1"');
    expect(pyproject).not.toContain('"openai ~= 1.0.0"');
  });

  test("renders Gemini sampling settings with the Gemini extra", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      model: {
        provider: "gemini",
        modelId: "gemini-2.5-flash",
        apiKeyArn:
          "arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default/apikeycredentialprovider/GeminiKey",
        maxTokens: 400,
        temperature: 0.3,
        topP: 0.9,
        topK: 20,
      },
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const loadModel = await Bun.file(join(result.agentPath, "model", "load.py")).text();
    expect(loadModel).toContain('params["max_output_tokens"] = 400');
    expect(loadModel).toContain('params["temperature"] = 0.3');
    expect(loadModel).toContain('params["top_p"] = 0.9');
    expect(loadModel).toContain('params["top_k"] = 20');
    expect(await Bun.file(join(result.agentPath, "pyproject.toml")).text()).toContain(
      '"strands-agents[gemini,web-fetch] ~= 1.57.1"',
    );
  });

  test("renders LiteLLM settings with the LiteLLM extra", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      model: {
        provider: "lite_llm",
        modelId: "bedrock/us.amazon.nova-lite-v1:0",
        maxTokens: 300,
        temperature: 0.1,
        topP: 0.7,
        additionalParams: { max_retries: 2 },
      },
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const loadModel = await Bun.file(join(result.agentPath, "model", "load.py")).text();
    expect(loadModel).toContain('params["max_tokens"] = 300');
    expect(loadModel).toContain('params["temperature"] = 0.1');
    expect(loadModel).toContain('params["top_p"] = 0.7');
    expect(loadModel).toContain('json.loads("{\\"max_retries\\":2}")');
    expect(await Bun.file(join(result.agentPath, "pyproject.toml")).text()).toContain(
      '"strands-agents[litellm,web-fetch] ~= 1.57.1"',
    );
  });

  test("renders released skills and sliding-window APIs", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      skills: [{ s3Uri: "s3://skills-bucket/team/" }],
      truncation: {
        strategy: "sliding_window",
        config: { slidingWindow: { messagesCount: 12 } },
      },
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const main = await Bun.file(join(result.agentPath, "main.py")).text();
    expect(main).toContain("from strands import AgentSkills");
    expect(main).toContain('SlidingWindowConversationManager(**{"window_size":12}, per_turn=True)');
    expect(await Bun.file(join(result.agentPath, "pyproject.toml")).text()).toContain(
      '"strands-agents[web-fetch] ~= 1.57.1"',
    );
  });

  test("emits a CodeZip runtime with no container files", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);

    const result = await drain(subject.exportHarness(project, exportInput()));

    expect(existsSync(join(result.agentPath, "Dockerfile"))).toBe(false);
    expect(existsSync(join(result.agentPath, ".dockerignore"))).toBe(false);
    const spec = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).json();
    const runtime = spec.runtimes.find((r: { name: string }) => r.name === "assistantAgent");
    expect(runtime.build).toBe("CodeZip");
    expect(runtime.runtimeVersion).toBe("PYTHON_3_14");
    expect(runtime.dockerfile).toBeUndefined();
  });

  test("exports a containerUri harness as CodeZip and reports the dropped image", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      containerUri: "111122223333.dkr.ecr.us-east-1.amazonaws.com/base-image:latest",
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    expect(existsSync(join(result.agentPath, "Dockerfile"))).toBe(false);
    expect(result.notes.map((note) => note.category)).toEqual(["Container image not carried over"]);
    const spec = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).json();
    const runtime = spec.runtimes.find((r: { name: string }) => r.name === "assistantAgent");
    expect(runtime.build).toBe("CodeZip");
  });

  test("writes generated IAM policy files next to the code", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      skills: [{ s3Uri: "s3://skills-bucket/team" }],
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const policy = await Bun.file(join(result.agentPath, "s3-skills-policy.json")).json();
    expect(policy.Statement[0].Resource).toEqual(["arn:aws:s3:::skills-bucket/team/*"]);
    const spec = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).json();
    const runtime = spec.runtimes.find((r: { name: string }) => r.name === "assistantAgent");
    expect(runtime.additionalPolicies).toEqual(["s3-skills-policy.json"]);
  });
});

describe("FsProjectManager.exportHarness side effects", () => {
  test("leaves the system prompt to the harness default when the harness sets none", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);
    const dir = join(project.rootPath, "app", "assistant");
    const configPath = join(dir, "harness.yaml");
    const config = parse(await Bun.file(configPath).text());
    delete config.systemPrompt;
    await Bun.write(configPath, stringify(config));
    await rm(join(dir, "system-prompt.md"), { force: true });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const main = await Bun.file(join(result.agentPath, "main.py")).text();
    expect(main).not.toContain("DEFAULT_SYSTEM_PROMPT");
    expect(main).not.toContain("system_prompt=");
  });

  test.each(["inline", "file"] as const)(
    "exports the %s prompt and inline summary without rewriting YAML",
    async (source) => {
      const { manager: subject } = manager();
      const project = await projectWithHarness(subject);
      const dir = join(project.rootPath, "app", "assistant");
      const configPath = join(dir, "harness.yaml");
      const config = parse(await Bun.file(configPath).text());
      const prompt = "  Explicit prompt.\nKeep its whitespace.\n";
      await Bun.write(
        join(dir, "system-prompt.md"),
        source === "file" ? prompt : "Conventional prompt loses.",
      );
      if (source === "file") delete config.systemPrompt;
      else config.systemPrompt = [{ text: prompt }];
      config.truncation = {
        strategy: "summarization",
        config: { summarization: { summarizationSystemPrompt: "  Keep the decisions.\n" } },
      };
      const yaml = "# Keep this customer comment.\n" + stringify(config);
      await Bun.write(configPath, yaml);
      const result = await drain(subject.exportHarness(project, exportInput()));
      const main = await Bun.file(join(result.agentPath, "main.py")).text();
      expect(main).toContain(prompt);
      expect(main).toContain("Keep the decisions.");
      expect(main).not.toContain("Conventional prompt loses.");
      expect(await Bun.file(configPath).text()).toBe(yaml);
    },
  );

  test("reports schema errors with the YAML path before creating export output", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);
    const configPath = join(project.rootPath, "app", "assistant", "harness.yaml");
    await Bun.write(
      configPath,
      "name: assistant\nmodel: {bedrockModelConfig: {modelId: example}}\nmaxIterations: 0\n",
    );
    await expect(drain(subject.exportHarness(project, exportInput()))).rejects.toThrow(
      /Invalid harness.yaml.*maxIterations/s,
    );
    expect(existsSync(join(project.rootPath, "app", "assistantAgent"))).toBe(false);
  });

  test("writes MCP header secrets to .env.local and registers their credentials", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      tools: [
        {
          type: "remote_mcp",
          name: "internal",
          config: {
            remoteMcp: { url: "https://mcp.internal.example", headers: { "X-Api-Key": "s3cret" } },
          },
        },
      ],
    });

    await drain(subject.exportHarness(project, exportInput()));

    const spec = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).json();
    const credential = spec.credentials[0];
    expect(credential.authorizerType).toBe("ApiKeyCredentialProvider");
    expect(credential.name).toMatch(/^ordersMcpinternalX-Api-Key-[a-f0-9]{10}$/);
    const envLocal = await Bun.file(join(project.rootPath, "agentcore", ".env.local")).text();
    expect(envLocal).toContain(
      `AGENTCORE_CREDENTIAL_${credential.name.replace(/-/g, "_").toUpperCase()}='s3cret'`,
    );
    const mcpClient = await Bun.file(
      join(project.rootPath, "app", "assistantAgent", "mcp_client", "client.py"),
    ).text();
    expect(mcpClient).toMatch(
      /def transport\(\):[\s\S]*headers = \{ "X-Api-Key": _get_[a-z0-9_]+_key\(\) \}[\s\S]*return streamablehttp_client/,
    );
  });

  test("exports a prefetched (service) harness without touching harness files", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);

    const result = await drain(
      subject.exportHarness(project, {
        prefetched: {
          spec: HarnessSpecSchema.parse({
            name: "remote_harness",
            model: { provider: "bedrock", modelId: "us.amazon.nova-lite-v1:0" },
          }),
          systemPrompt: "Fetched prompt.",
        },
        targetAgentName: "exported_arn",
      }),
    );

    expect(result.harnessName).toBe("remote_harness");
    expect(await Bun.file(join(result.agentPath, "main.py")).text()).toContain("Fetched prompt.");
  });

  test("cleans up the agent dir and .env.local when the spec write fails", async () => {
    const failing = failingWriteJson();
    const { manager: subject } = manager({ json: failing.json });
    const project = await projectWithHarness(subject, {
      tools: [
        {
          type: "remote_mcp",
          name: "internal",
          config: {
            remoteMcp: { url: "https://mcp.internal.example", headers: { "X-Api-Key": "s3cret" } },
          },
        },
      ],
    });

    failing.failNextWrite();
    await expect(drain(subject.exportHarness(project, exportInput()))).rejects.toThrow("disk full");

    expect(existsSync(join(project.rootPath, "app", "assistantAgent"))).toBe(false);
    // The scaffolded .env.local survives, but the staged secret is rolled back.
    expect(await Bun.file(join(project.rootPath, "agentcore", ".env.local")).text()).not.toContain(
      "AGENTCORE_CREDENTIAL_ORDERSMCPINTERNALXAPIKEY",
    );
    const spec = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes.map((r: { name: string }) => r.name)).not.toContain("assistantAgent");
  });

  test("reads the harness from its registry path", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      model: { provider: "bedrock", modelId: "us.amazon.nova-lite-v1:0", maxTokens: 128 },
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    expect(await Bun.file(join(result.agentPath, "model", "load.py")).text()).toContain(
      "max_tokens=128",
    );
    // The system prompt comes from system-prompt.md, the file add-harness wrote.
    expect(await Bun.file(join(result.agentPath, "main.py")).text()).toContain(
      'DEFAULT_SYSTEM_PROMPT = """You are a terse assistant."""',
    );
  });
});

/** A ReadWriteJson that can be told to fail its next write, delegating otherwise. */
function failingWriteJson() {
  const real = new FsReadWriteJson({ logger: createSilentLogger() });
  let shouldFail = false;
  const json: ReadWriteJson = {
    read: (path, schema) => real.read(path, schema),
    write: (path, data) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("disk full");
      }
      return real.write(path, data);
    },
  };
  return { json, failNextWrite: () => (shouldFail = true) };
}

const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe("FsProjectManager.exportHarness generated Python", () => {
  // Every template branch must render to valid Python; Handlebars cannot check that.
  const variants: Record<string, Record<string, unknown> & { withProjectMemory?: boolean }> = {
    default: {},
    "no builtins or plugins": { allowedTools: ["exa"] },
    "subagent without builtins": { allowedTools: ["subagent"] },
    "subagent with limits": { maxIterations: 3, maxTokens: 64, timeoutSeconds: 5 },
    "memory and skills": {
      memory: { mode: "existing", name: "chat_history" },
      skills: [{ s3Uri: "s3://bucket/skills" }],
      withProjectMemory: true,
    },
    "inline function and MCP": {
      tools: [
        {
          type: "inline_function",
          name: "lookup",
          config: {
            inlineFunction: { description: "Look up an order", inputSchema: { type: "object" } },
          },
        },
        {
          type: "remote_mcp",
          name: "exa",
          config: { remoteMcp: { url: "https://mcp.exa.ai/mcp" } },
        },
      ],
    },
  };

  for (const [name, harness] of Object.entries(variants)) {
    test.skipIf(!hasPython)(`compiles: ${name}`, async () => {
      const { withProjectMemory, ...harnessConfig } = harness;
      const { manager: subject } = manager();
      let project = await projectWithHarness(subject, harnessConfig);
      if (withProjectMemory) {
        project = await drain(
          subject.addResource(project, {
            resourceType: "memory",
            resourceConfig: {
              name: "chat_history",
              eventExpiryDuration: 30,
              strategies: [{ type: "SEMANTIC" }],
            },
          }),
        );
      }

      const result = await drain(subject.exportHarness(project, exportInput()));

      const files = [
        "main.py",
        "harness_runtime.py",
        join("model", "load.py"),
        join("mcp_client", "client.py"),
      ].map((file) => join(result.agentPath, file));
      // A missing context value renders as `undefined`, which compiles but fails at import.
      for (const file of files) expect(await Bun.file(file).text()).not.toContain("undefined");
      const compiled = spawnSync("python3", ["-m", "py_compile", ...files], { encoding: "utf-8" });
      expect(compiled.stderr).toBe("");
      expect(compiled.status).toBe(0);
    });
  }
});
