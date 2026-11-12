import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import z from "zod";
import { parse, stringify } from "yaml";
import { FsProjectManager } from "./manager";
import { prepareRuntimes } from "./runtimeBuild";
import { FsReadWriteJson, type ReadWriteJson } from "../../io";
import { createSilentLogger, TestIdentityClient } from "../../testing";
import { resolveRuntimeTemplateShortcut } from "../../handlers/project/shortcuts";
import type { ExportHarnessInput, Project, ProjectEvent } from "../../handlers/project/types";
import { HarnessSpecSchema } from "../../projectSchemas/harness";
import { readEnvFile } from "../../io/envFile";

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
    expect(runtime).toContain('_PLUGIN_TOOL_NAMES = frozenset(["todo_write","retrieve_context"])');
    expect(runtime).toContain("evict_after_cycles=None");
    expect(runtime).toContain("def _add_subagent_tool(");
    const loadModel = await Bun.file(join(result.agentPath, "model", "load.py")).text();
    expect(loadModel).toContain(
      'cache_config=CacheConfig(strategy="auto", system_prompt_ttl=True, tools_ttl=True)',
    );
    const pyproject = await Bun.file(join(result.agentPath, "pyproject.toml")).text();
    expect(pyproject).toContain('"strands-agents[web-fetch] >= 1.63.0, < 2.0.0"');
    expect(pyproject).toContain('"strands-harness >= 0.3.3, < 0.4.0"');
  });

  test("loads a Bedrock model that rejects cache points without prompt caching", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      model: { provider: "bedrock", modelId: "us.anthropic.claude-3-haiku-20240307-v1:0" },
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const loadModel = await Bun.file(join(result.agentPath, "model", "load.py")).text();
    expect(loadModel).toContain('model_id="us.anthropic.claude-3-haiku-20240307-v1:0"');
    expect(loadModel).not.toContain("CacheConfig");
    // Nothing is cached, so side calls keep the agent's model.
    expect(loadModel).not.toContain("load_aux_model");
    expect(await Bun.file(join(result.agentPath, "main.py")).text()).not.toContain("aux_model");
  });

  test("makes side calls such as summaries on an uncached copy of a prompt-cached model", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      model: { provider: "bedrock", modelId: "global.anthropic.claude-sonnet-5-5" },
      truncation: { strategy: "summarization" },
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const loadModel = await Bun.file(join(result.agentPath, "model", "load.py")).text();
    expect(loadModel).toContain("def load_model(*, prompt_caching: bool = True) -> BedrockModel:");
    expect(loadModel).toContain(
      'cache_config=CacheConfig(strategy="auto", system_prompt_ttl=True, tools_ttl=True) if prompt_caching else None,',
    );
    expect(loadModel).toContain("def load_aux_model() -> BedrockModel:");
    expect(loadModel).toContain("return load_model(prompt_caching=False)");
    const main = await Bun.file(join(result.agentPath, "main.py")).text();
    expect(main).toContain("from model.load import load_model, load_aux_model\n");
    expect(main).toMatch(/model=load_model\(\),\n\s+aux_model=load_aux_model\(\),/);
    // A subagent on the parent's model also summarizes on the parent's uncached copy.
    const runtime = await Bun.file(join(result.agentPath, "harness_runtime.py")).text();
    expect(runtime).toContain("aux_model=None if spec.model else parent.aux_model,");
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
    expect(pyproject).toContain('"strands-agents >= 1.63.0, < 2.0.0"');
  });

  test("builds a read tool without media for a model that rejects media blocks", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      model: { provider: "bedrock", modelId: "openai.gpt-oss-120b-1:0" },
      allowedTools: ["read", "write"],
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const main = await Bun.file(join(result.agentPath, "main.py")).text();
    expect(main).toContain("from strands_harness.tools import make_read, write\n");
    expect(main).toContain("read = make_read(media=False)\ntools.append(read)\n");
  });

  test("wraps the vended shell with the harness runtime's timeout default and result keys", async () => {
    const { manager: subject } = manager();
    const render = async (allowedTools: string[]) => {
      const project = await projectWithHarness(subject, { allowedTools });
      const result = await drain(subject.exportHarness(project, exportInput()));
      return {
        main: await Bun.file(join(result.agentPath, "main.py")).text(),
        runtime: await Bun.file(join(result.agentPath, "harness_runtime.py")).text(),
      };
    };

    const withShell = await render(["shell"]);
    expect(withShell.main).toContain("tools.append(make_managed_shell())");
    expect(withShell.main).not.toContain("make_shell(");
    expect(withShell.runtime).toContain(
      "async def shell(command: str, tool_context: ToolContext, timeout: int = 300) -> dict:",
    );
    expect(withShell.runtime).toContain(
      'return {"stdout": result["output"], "stderr": result["error"], "exit_code": result["exit_code"]}',
    );
    // A timeout's partial output uses the same keys.
    expect(withShell.runtime).toContain(
      'partial = {"stdout": error.stdout, "stderr": error.stderr, "exit_code": 124}',
    );
    const withoutShell = await render(["read"]);
    expect(withoutShell.main).not.toContain("shell");
    expect(withoutShell.runtime).not.toContain("shell");
  });

  test("keeps a background child from holding a shell call open past its timeout", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, { allowedTools: ["shell"] });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const runtime = await Bun.file(join(result.agentPath, "harness_runtime.py")).text();
    expect(runtime).toContain("import asyncio\n");
    expect(runtime).toContain("import os\n");
    // The command reaches the shell as written: the local environment follows the shell's exit, so
    // no wrapping is needed to keep a backgrounded command from holding the call open.
    expect(runtime).not.toContain('command = "{ " + command');
    expect(runtime).toContain(
      "deadline = None if timeout is None else timeout + _SHELL_DEADLINE_GRACE_SECONDS",
    );
    expect(runtime).toContain(
      "result = await asyncio.wait_for(run(command, tool_context, timeout), deadline)",
    );
    // The vended timeout subclasses TimeoutError, so it is caught first and keeps its partial output.
    const vendedTimeout = runtime.indexOf("except SandboxTimeoutError as error:");
    const deadlineTimeout = runtime.indexOf("except asyncio.TimeoutError:");
    expect(vendedTimeout).toBeGreaterThan(-1);
    expect(deadlineTimeout).toBeGreaterThan(vendedTimeout);
    // Past the deadline the model sees the vended timeout's failed result, without output.
    expect(runtime.slice(deadlineTimeout)).toMatch(
      /error = SandboxTimeoutError\(timeout\)\n\s+partial = \{"stdout": "", "stderr": "", "exit_code": 124\}\n\s+error\.args = \(f"\{error\}\\n\{json\.dumps\(partial\)\}",\)\n\s+raise error from None\n/,
    );
  });

  test("ends a shell call once its shell exits and kills what the command left running", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, { allowedTools: ["shell"] });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const runtime = await Bun.file(join(result.agentPath, "harness_runtime.py")).text();
    for (const line of [
      "import contextlib\n",
      "import shlex\n",
      "import signal\n",
      "from strands.sandbox import ExecutionResult\n",
      "from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment\n",
      "from strands.sandbox.posix_shell import build_shell_env_prefix\n",
    ]) {
      expect(runtime).toContain(line);
    }
    // The agent's sandbox is read at call time, as by the vended tool. On POSIX the agent's host
    // default is replaced by the local shell; Windows keeps the vended environment, which runs PowerShell.
    expect(runtime).toContain("vended = make_shell()\n");
    expect(runtime).toContain(
      'local = None if os.name == "nt" else make_shell(sandbox=_LocalShell())',
    );
    expect(runtime).not.toContain('vended = make_shell() if os.name == "nt"');
    // A sandbox configured on the agent (Docker, SSH, a subclass of the host default) runs the command.
    expect(runtime).toMatch(
      /host_default = type\(tool_context\.agent\.sandbox\) is NotASandboxLocalEnvironment\n\s+run = local if local is not None and host_default else vended\n/,
    );
    const localShell = runtime.slice(
      runtime.indexOf("class _LocalShell(NotASandboxLocalEnvironment):"),
      runtime.indexOf("def make_managed_shell():"),
    );
    expect(localShell).toContain(
      "async def execute_streaming(self, command, *, timeout=None, cwd=None, env=None, **kwargs):",
    );
    // The vended command line, in a process group that the shell leads.
    expect(localShell).toContain(
      'full_command = f"cd {shlex.quote(target_cwd)} && {build_shell_env_prefix(env)}{command}"',
    );
    expect(localShell).toContain("start_new_session=True,");
    // The call follows the shell's exit, which the protocol reports whatever holds the pipes.
    expect(runtime).toMatch(
      /def process_exited\(self\):\n\s+if not self\.exited\.done\(\):\n\s+self\.exited\.set_result\(None\)\n/,
    );
    const exit = localShell.indexOf("await asyncio.wait([process.exited], timeout=timeout)");
    // A timeout kills the whole group while the shell still runs.
    expect(localShell.slice(exit)).toMatch(
      /if not process\.exited\.done\(\):\n\s+timed_out = True\n\s+_kill_process_group\(transport\.get_pid\(\)\)\n\s+await process\.exited\n/,
    );
    // Once the shell exits, a background child holding the pipes delays the result by a second at most,
    // and only then is what the command left running killed.
    expect(runtime).toContain("_SHELL_PIPE_RELEASE_SECONDS = 1\n");
    const release = localShell.indexOf(
      "await asyncio.wait([process.pipes_closed], timeout=_SHELL_PIPE_RELEASE_SECONDS)",
    );
    const leftovers = localShell.indexOf("_kill_process_group(transport.get_pid())", release);
    expect(exit).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(exit);
    expect(leftovers).toBeGreaterThan(release);
    expect(runtime).toContain("os.killpg(pgid, signal.SIGKILL)");
    expect(localShell).toContain("process.exited.add_done_callback(lambda _: transport.close())");
    // A timeout keeps the vended error and partial output; otherwise the shell's own exit code counts.
    expect(localShell).toContain(
      "raise SandboxTimeoutError(timeout, process.text(1), process.text(2))",
    );
    expect(localShell).toContain("exit_code=128 - returncode if returncode < 0 else returncode,");
  });

  test("offloads large tool results behind retrieve_context and keeps skills whole", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      allowedTools: ["retrieve_context"],
      skills: [{ s3Uri: "s3://skills-bucket/team/" }],
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const runtime = await Bun.file(join(result.agentPath, "harness_runtime.py")).text();
    expect(runtime).toContain('_PLUGIN_TOOL_NAMES = frozenset(["retrieve_context"])');
    expect(runtime).toContain("@tool(name=_RETRIEVAL_TOOL, context=True)");
    expect(runtime).toContain("include_retrieval_tool=False,");
    // A retrieval is never offloaded again, and a skill up to 10,000 tokens stays whole.
    expect(runtime).toContain(
      "tool_name != _RETRIEVAL_TOOL and (tool_name not in exempt or token_count > _EXEMPT_MAX_TOKENS)",
    );
    expect(runtime).toContain('exempt_tools=["skills"] if skill_plugins else []');
  });

  test("reports usage per model call, then what subagent calls added", async () => {
    const { manager: subject } = manager();
    const render = async (allowedTools: string[]) => {
      const project = await projectWithHarness(subject, { allowedTools });
      const result = await drain(subject.exportHarness(project, exportInput()));
      return {
        main: await Bun.file(join(result.agentPath, "main.py")).text(),
        runtime: await Bun.file(join(result.agentPath, "harness_runtime.py")).text(),
      };
    };

    const withSubagent = await render(["subagent"]);
    // The agent's own calls stream their frames as they happen, as without a subagent.
    expect(withSubagent.main).toMatch(
      /if "metadata" in event\["event"\]:\n(\s+#.*\n)*\s+budget\.streamed\(event\["event"\]\["metadata"\]\)\n\s+yield event\n/,
    );
    // One more frame carries only the usage those frames did not, once there is any.
    expect(withSubagent.main).toMatch(
      /metadata = budget\.unstreamed_metadata_event\(\)\n\s+if metadata is not None:\n\s+yield metadata\n/,
    );
    expect(withSubagent.runtime).toContain(
      "usage = {field: max(0, self.usage[field] - self.streamed_usage[field]) for field in self.usage}",
    );
    expect(withSubagent.runtime).toContain(
      "latency_ms = max(0, self.latency_ms - self.streamed_latency_ms)",
    );
    expect(withSubagent.runtime).toMatch(
      /if not any\(usage\.values\(\)\) and not latency_ms:\n\s+return None\n/,
    );
    expect(withSubagent.runtime).not.toContain("def metadata_event(");
    const without = await render(["shell"]);
    expect(without.main).not.toContain("budget.streamed(");
    expect(without.main).not.toContain("unstreamed_metadata_event");
    expect(without.main).toMatch(/if "metadata" in event\["event"\]:\n\s+yield event/);
  });

  test("reports what subagent calls added before an invocation fails", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, { allowedTools: ["subagent"] });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const main = await Bun.file(join(result.agentPath, "main.py")).text();
    // Any error but cancellation or a closed stream, which cannot take another frame; the
    // else branch reports it on success, so it is sent once.
    expect(main).toMatch(
      /\n {4}except Exception:\n(\s+#.*\n)*\s+metadata = budget\.unstreamed_metadata_event\(\)\n\s+if metadata is not None:\n\s+yield metadata\n\s+raise\n {4}else:\n\s+metadata = budget\.unstreamed_metadata_event\(\)\n\s+if metadata is not None:\n\s+yield metadata\n {4}finally:\n/,
    );
    expect(main.match(/budget\.unstreamed_metadata_event\(\)/g)).toHaveLength(2);
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

  test("registers customer tools that share a builtin's name under distinct names", async () => {
    const { manager: subject } = manager();
    const inline = (name: string) => ({
      type: "inline_function",
      name,
      config: { inlineFunction: { description: "d", inputSchema: { type: "object" } } },
    });
    const project = await projectWithHarness(subject, {
      tools: [inline("shell"), inline("read"), inline("web-fetch"), inline("subagent")],
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const main = await Bun.file(join(result.agentPath, "main.py")).text();
    expect(main).toContain('tools.append(RenamedTool(make_managed_shell(), "builtin_shell"))');
    expect(main).toContain('tools.append(RenamedTool(read, "builtin_read"))');
    expect(main).toContain("tools.append(write)\n");
    expect(main).toContain(
      'tools.append(RenamedTool(make_web_fetch(mode="markdown"), "builtin_web_fetch"))',
    );
    expect(main).toContain('tools.append(_make_inline_tool("read_read", _INLINE_SPEC_read))');
    expect(main).toContain(
      '_INLINE_FUNCTION_NAMES = { "shell_shell", "read_read", "web-fetch_web-fetch", "subagent_subagent" }',
    );
    const runtime = await Bun.file(join(result.agentPath, "harness_runtime.py")).text();
    expect(runtime).toContain("class RenamedTool(AgentTool):");
    // The subagent inherits the builtins under their registered names.
    expect(runtime).toContain(
      '_SUBAGENT_BUILTIN_TOOL_NAMES = frozenset(["builtin_shell","builtin_read","write","edit","builtin_web_fetch"])',
    );
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
    // With the subagent tool on, that turn's frame still streams, so the final frame leaves it out.
    expect(main).toMatch(
      /budget\.after_model_call\(event\["event"\]\["metadata"\]\)\n(\s+#.*\n)*\s+budget\.streamed\(event\["event"\]\["metadata"\]\)\n\s+yield event\n\s+if inline_handoff:\n\s+break\n/,
    );
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

  test("connects gateway tools through their URL variable and records the connections", async () => {
    const { manager: subject } = manager();
    const gatewayArn = "arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/example-abc123";
    const project = await projectWithHarness(subject, {
      allowedTools: ["@tools/*", "@partner"],
      tools: [
        {
          type: "agentcore_gateway",
          name: "tools",
          config: { agentCoreGateway: { gatewayArn, outboundAuth: { awsIam: {} } } },
        },
        {
          type: "agentcore_gateway",
          name: "partner",
          config: {
            agentCoreGateway: {
              gatewayArn,
              outboundAuth: {
                oauth: {
                  providerArn:
                    "arn:aws:bedrock-agentcore:us-east-1:123456789012:token-vault/default/oauth2credentialprovider/partner-oauth",
                  scopes: ["partner/invoke"],
                },
              },
            },
          },
        },
      ],
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const client = await Bun.file(join(result.agentPath, "mcp_client", "client.py")).text();
    expect(client).toContain('url = os.environ.get("GATEWAY_TOOLS_URL")');
    expect(client).toMatch(/GATEWAY_TOOLS_URL"\)[\s\S]*?auth = _SigV4Auth\(\)/);
    expect(client).toContain('provider_name="partner-oauth"');
    expect(client).toMatch(/auth = _BearerAuth\(_get_partner_[a-f0-9]{10}_token\)/);
    const main = await Bun.file(join(result.agentPath, "main.py")).text();
    expect(main).toContain("mcp_clients = get_all_mcp_clients()");
    const pyproject = await Bun.file(join(result.agentPath, "pyproject.toml")).text();
    expect(pyproject).not.toMatch(/^ {5,}"/m);
    const spec = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).json();
    expect(
      spec.runtimes.find((runtime: { name: string }) => runtime.name === "assistantAgent")
        .connections,
    ).toEqual([
      { id: "tools", to: { type: "gateway", arn: gatewayArn, outboundAuth: { awsIam: {} } } },
      expect.objectContaining({ id: "partner" }),
    ]);
    expect(
      (await readEnvFile(join(project.rootPath, "agentcore", ".env.local"))).GATEWAY_TOOLS_URL,
    ).toBe("https://example-abc123.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp");
    const notes = await Bun.file(join(result.agentPath, "EXPORT_NOTES.md")).text();
    expect(notes).not.toContain("Gateway tool not exported");
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
          strategies: [
            { type: "SEMANTIC" },
            {
              type: "EPISODIC",
              namespaceTemplates: ["/episodes/{actorId}/{sessionId}"],
              reflectionNamespaceTemplates: ["/episodes/{actorId}"],
            },
          ],
        },
      }),
    );

    const result = await drain(subject.exportHarness(project, exportInput()));

    const session = await Bun.file(join(result.agentPath, "memory", "session.py")).text();
    expect(session).toContain('MEMORY_ID = os.getenv("MEMORY_CHAT_HISTORY_ID")');
    expect(session).toContain(
      'f"/users/{actor_id}/facts": RetrievalConfig(top_k=3, relevance_score=0.0)',
    );
    expect(session).toContain(
      'f"/episodes/{actor_id}/{session_id}": RetrievalConfig(top_k=5, relevance_score=0.0)',
    );
    expect(session).not.toContain("/preferences");
    expect(session).not.toContain("/summaries/");
    const main = await Bun.file(join(result.agentPath, "main.py")).text();
    expect(main).toContain("from memory.session import get_memory_session_manager");
    expect(main).toMatch(
      /model=load_model\(\),\n\s+aux_model=load_aux_model\(\),\n\s+session_manager=/,
    );
    expect(result.notes).toEqual([]);
  });

  test("uses the default session when the request has no session id", async () => {
    // The runtime's request context reports a missing session header as session_id=None, so a
    // getattr default alone would pass None on.
    const fallback = 'session_id = getattr(context, "session_id", None) or "default-session"';
    const { manager: subject } = manager();
    const plain = await drain(
      subject.exportHarness(await projectWithHarness(subject), exportInput()),
    );
    expect(await Bun.file(join(plain.agentPath, "main.py")).text()).toContain(fallback);

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
    const withMemory = await drain(subject.exportHarness(project, exportInput()));
    const main = await Bun.file(join(withMemory.agentPath, "main.py")).text();
    expect(main).toContain(fallback);
    expect(main).toContain('user_id = getattr(context, "user_id", None) or "default-user"');
  });

  test.each([0, 0.7])(
    "renders relevanceScore=%p and notes messagesCount",
    async (relevanceScore) => {
      const { manager: subject } = manager();
      let project = await projectWithHarness(subject, {
        memory: {
          mode: "existing",
          name: "chat_history",
          messagesCount: 12,
          retrievalConfig: { topK: 8, relevanceScore },
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
      expect(session).toContain(`RetrievalConfig(top_k=8, relevance_score=${relevanceScore})`);
      expect(result.notes.map((note) => note.category)).toContain(
        "Memory messagesCount is not directly portable to Strands",
      );
    },
  );

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
      'IDENTITY_PROVIDER_NAME = os.environ.get("CREDENTIAL_OPENAIKEY_NAME", "OpenAiKey")',
    );
    expect(loadModel).toContain('params["max_output_tokens"] = 512');
    expect(loadModel).toContain('params["temperature"] = 0.2');
    expect(loadModel).toContain('params["top_p"] = 0.8');
    const pyproject = await Bun.file(join(result.agentPath, "pyproject.toml")).text();
    expect(pyproject).toContain('"strands-agents[openai,web-fetch] >= 1.63.0, < 2.0.0"');
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
      '"strands-agents[gemini,web-fetch] >= 1.63.0, < 2.0.0"',
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
      '"strands-agents[litellm,web-fetch] >= 1.63.0, < 2.0.0"',
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
      '"strands-agents[web-fetch] >= 1.63.0, < 2.0.0"',
    );
  });

  test("imports os only for the Git skill credential lookup", async () => {
    const { manager: subject } = manager();
    const render = async (harness: Record<string, unknown>) => {
      const project = await projectWithHarness(subject, harness);
      const result = await drain(subject.exportHarness(project, exportInput()));
      return Bun.file(join(result.agentPath, "main.py")).text();
    };

    // Mounted storage is reached through the harness file tools, which need no os import.
    const mounted = await render({ sessionStoragePath: "/mnt/data/" });
    expect(mounted).not.toMatch(/^import os$/m);
    const gitCredential = await render({
      sessionStoragePath: "/mnt/data/",
      skills: [
        {
          gitUrl: "https://github.com/example/skills.git",
          auth: {
            credentialArn:
              "arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default/apikeycredentialprovider/GitKey",
          },
        },
      ],
    });
    expect(gitCredential).toMatch(/^import os$/m);
    expect(gitCredential).toContain('IdentityClient(os.environ.get("AWS_REGION"');
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
    // dev/build/deploy re-derive build settings from the code; an export already agrees.
    const prepared = prepareRuntimes(project.rootPath, spec.runtimes, "dev");
    expect(prepared.changed).toEqual([]);
    expect(prepared.messages).toEqual([]);
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
    expect(envLocal).not.toContain("s3cret");
    expect(
      (await readEnvFile(join(project.rootPath, "agentcore", ".env.local")))[
        `AGENTCORE_CREDENTIAL_${credential.name.replace(/-/g, "_").toUpperCase()}`
      ],
    ).toBe("s3cret");
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
    "model without prompt caching": {
      model: { provider: "bedrock", modelId: "anthropic.claude-3-haiku-20240307-v1:0" },
    },
    "no builtins or plugins": { allowedTools: ["exa"] },
    "subagent without builtins": { allowedTools: ["subagent"] },
    "subagent with limits": { maxIterations: 3, maxTokens: 64, timeoutSeconds: 5 },
    "session storage": { sessionStoragePath: "/mnt/data/" },
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
    "inline functions sharing builtin names": {
      tools: ["shell", "read", "web_fetch"].map((name) => ({
        type: "inline_function",
        name,
        config: { inlineFunction: { description: "d", inputSchema: { type: "object" } } },
      })),
    },
    "renamed read tool without media": {
      model: { provider: "bedrock", modelId: "openai.gpt-oss-120b-1:0" },
      tools: [
        {
          type: "inline_function",
          name: "read",
          config: { inlineFunction: { description: "d", inputSchema: { type: "object" } } },
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
