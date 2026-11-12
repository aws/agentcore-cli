"""Builds the agent the way the harness does, and bounds it by the invocation's limits."""

{{#if hasShell}}
import asyncio
import contextlib
{{/if}}
{{#if hasContextOffloader}}
import hashlib
{{/if}}
{{#if hasShell}}
import json
{{/if}}
{{#if (or hasContextOffloader hasShell)}}
import os
{{/if}}
{{#if hasShell}}
import shlex
import signal
{{/if}}
{{#if hasContextOffloader}}
import tempfile
{{/if}}
{{#if (or hasContextOffloader hasShell)}}

from strands import {{#if hasShell}}SandboxTimeoutError, {{/if}}ToolContext, tool
{{/if}}
from strands.hooks import AfterModelCallEvent, BeforeModelCallEvent, HookProvider
{{#if hasShell}}
from strands.sandbox import ExecutionResult
from strands.sandbox.not_a_sandbox_local_environment import NotASandboxLocalEnvironment
from strands.sandbox.posix_shell import build_shell_env_prefix
{{/if}}
{{#if hasContextOffloader}}
from strands.storage import LocalFileStorage
{{/if}}
from strands.tools.executors import SequentialToolExecutor
{{#if hasSubagent}}
from strands.tools.mcp import MCPAgentTool
{{/if}}
{{#if (or maxIterations maxTokens)}}
from strands.types.exceptions import EventLoopException
{{/if}}
{{#if builtinToolRenames}}
from strands.types.tools import AgentTool
{{/if}}
{{#if hasContextOffloader}}
from strands.vended_plugins.context_offloader import ContextOffloader
{{/if}}
{{#if hasShell}}
from strands.vended_tools import make_shell
{{/if}}
from strands_harness import create_harness
{{#if hasSubagent}}
from strands_harness.tools import Choice, make_subagent
from strands_harness.tools.subagent import GENERALIST
{{/if}}
{{#if hasContextOffloader}}
from typing_extensions import TypedDict
{{/if}}

# Tools vended by the enabled built-in plugins.
_PLUGIN_TOOL_NAMES = frozenset({{safeJson pluginToolNames}})


class LimitExceeded(Exception):
    """The invocation reached an execution limit; stop_reason is the harness stop reason."""

    def __init__(self, stop_reason):
        super().__init__(stop_reason)
        self.stop_reason = stop_reason


_USAGE_FIELDS = ("inputTokens", "outputTokens", "totalTokens")
_CACHE_USAGE_FIELDS = ("cacheReadInputTokens", "cacheWriteInputTokens")


def _add_call_usage(usage, metadata):
    """Add a model call's token usage, from its metadata, to ``usage``; return its latency in ms."""
    call_usage = metadata.get("usage")
    if isinstance(call_usage, dict):
        for field in _USAGE_FIELDS + _CACHE_USAGE_FIELDS:
            if isinstance(call_usage.get(field), (int, float)):
                usage[field] += int(call_usage[field])
    latency_ms = (metadata.get("metrics") or {}).get("latencyMs")
    return int(latency_ms) if isinstance(latency_ms, (int, float)) else 0


class InvocationBudget:
    """One budget shared by the agent and every subagent it runs within an invocation.

    Each model call reserves an iteration and adds its token usage, so limits and the reported
    usage cover the whole delegation tree.
    """

    def __init__(self):
        self.iterations = 0
        self.usage = dict.fromkeys(_USAGE_FIELDS + _CACHE_USAGE_FIELDS, 0)
        self.latency_ms = 0
        # The part of the usage that metadata frames streamed to the caller already carried.
        self.streamed_usage = dict.fromkeys(_USAGE_FIELDS + _CACHE_USAGE_FIELDS, 0)
        self.streamed_latency_ms = 0

    def before_model_call(self):
        self.iterations += 1
        {{#if (or maxIterations maxTokens)}}
        # Raised as EventLoopException, which Strands re-raises unchanged; any other exception
        # would be logged as a failed event loop cycle.
        {{/if}}
        {{#if maxIterations}}
        if self.iterations > {{maxIterations}}:
            raise EventLoopException(LimitExceeded("max_iterations_exceeded"))
        {{/if}}
        {{#if maxTokens}}
        if self.usage["outputTokens"] >= {{maxTokens}}:
            raise EventLoopException(LimitExceeded("max_output_tokens_exceeded"))
        {{/if}}

    def after_model_call(self, metadata):
        self.latency_ms += _add_call_usage(self.usage, metadata)

    def streamed(self, metadata):
        """Note a model call's metadata frame that was streamed to the caller as is."""
        self.streamed_latency_ms += _add_call_usage(self.streamed_usage, metadata)

    def unstreamed_metadata_event(self):
        """A metadata frame with the usage no streamed frame carried, such as subagent calls', or None.

        Added to the streamed frames, it brings the reported usage to the invocation total.
        """
        # Never negative: a streamed frame the budget hook did not see must not reduce the total.
        usage = {field: max(0, self.usage[field] - self.streamed_usage[field]) for field in self.usage}
        latency_ms = max(0, self.latency_ms - self.streamed_latency_ms)
        if not any(usage.values()) and not latency_ms:
            return None
        usage = {field: count for field, count in usage.items() if count or field in _USAGE_FIELDS}
        return {"event": {"metadata": {"usage": usage, "metrics": {"latencyMs": latency_ms}}}}


class _BudgetHook(HookProvider):
    """Charge an agent's model calls to the budget in its invocation state.

    A subagent receives a copy of its parent's invocation state, so both charge the same budget.
    """

    def register_hooks(self, registry, **kwargs):
        registry.add_callback(BeforeModelCallEvent, self._before)
        registry.add_callback(AfterModelCallEvent, self._after)

    def _before(self, event):
        budget = event.invocation_state.get("budget")
        if budget is not None:
            budget.before_model_call()

    def _after(self, event):
        budget = event.invocation_state.get("budget")
        if budget is not None and event.stop_response is not None:
            budget.after_model_call(event.stop_response.message.get("metadata") or {})
{{#if builtinToolRenames}}


class RenamedTool(AgentTool):
    """Expose a tool under another model-facing name without mutating it.

    As in the harness runtime, a built-in tool that shares its name with another tool is
    registered as builtin_<name>.
    """

    def __init__(self, tool, name):
        super().__init__()
        self._tool = tool
        self._name = name

    @property
    def tool_name(self):
        return self._name

    @property
    def tool_spec(self):
        return {**self._tool.tool_spec, "name": self._name}

    @property
    def tool_type(self):
        return self._tool.tool_type

    @property
    def supports_hot_reload(self):
        return self._tool.supports_hot_reload

    @property
    def is_dynamic(self):
        return self._tool.is_dynamic

    def mark_dynamic(self):
        self._tool.mark_dynamic()

    def get_display_properties(self):
        return {**self._tool.get_display_properties(), "Name": self._name}

    def stream(self, tool_use, invocation_state, **kwargs):
        return self._tool.stream(tool_use, invocation_state, **kwargs)
{{/if}}
{{#if hasShell}}


# How long past its timeout a command may hold the call open before it is abandoned.
_SHELL_DEADLINE_GRACE_SECONDS = 2
# How long a command's output pipes may stay open after its shell exits, as in the harness runtime.
_SHELL_PIPE_RELEASE_SECONDS = 1


class _ShellCommand(asyncio.SubprocessProtocol):
    """Collects a command's output, and notes when its shell exits and when both output pipes close."""

    def __init__(self):
        loop = asyncio.get_running_loop()
        self.exited = loop.create_future()
        self.pipes_closed = loop.create_future()
        self._output = {1: bytearray(), 2: bytearray()}
        self._open_pipes = {1, 2}

    def pipe_data_received(self, fd, data):
        self._output[fd] += data

    def pipe_connection_lost(self, fd, exc):
        self._open_pipes.discard(fd)
        if not self._open_pipes and not self.pipes_closed.done():
            self.pipes_closed.set_result(None)

    def process_exited(self):
        if not self.exited.done():
            self.exited.set_result(None)

    def text(self, fd):
        return self._output[fd].decode(errors="replace")


def _kill_process_group(pgid):
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(pgid, signal.SIGKILL)


class _LocalShell(NotASandboxLocalEnvironment):
    """The vended local environment on POSIX, except that a command is done once its shell exits.

    The vended one returns when the output pipes close, so a background child that inherits them
    (``./server &``) holds the call open, past its timeout too. As in the harness runtime, once the
    shell exits the pipes get a moment for the last output and are then closed, and the shell's
    process group is killed with whatever the command left running. The result keeps the output
    and the shell's own exit code. The command line and the timeout are as in the vended
    environment: a timeout kills the group and raises ``SandboxTimeoutError`` with the output so far.
    """

    async def execute_streaming(self, command, *, timeout=None, cwd=None, env=None, **kwargs):
        target_cwd = cwd if cwd is not None else os.getcwd()
        full_command = f"cd {shlex.quote(target_cwd)} && {build_shell_env_prefix(env)}{command}"
        transport, process = await asyncio.get_running_loop().subprocess_exec(
            _ShellCommand,
            "sh",
            "-c",
            full_command,
            stdin=None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            # The shell leads a new process group, so one kill reaches everything the command started.
            start_new_session=True,
        )
        timed_out = False
        try:
            await asyncio.wait([process.exited], timeout=timeout)
            if not process.exited.done():
                timed_out = True
                _kill_process_group(transport.get_pid())
                await process.exited
            # The exit is seen as it happens, whatever holds the pipes; a background child holding them
            # delays the result by this much at most.
            await asyncio.wait([process.pipes_closed], timeout=_SHELL_PIPE_RELEASE_SECONDS)
        finally:
            if not timed_out:
                # What the command left running, or all of it if the call was cancelled.
                _kill_process_group(transport.get_pid())
            # Closing before asyncio has seen the shell exit would reap it ahead of asyncio's watcher.
            process.exited.add_done_callback(lambda _: transport.close())
        if timed_out:
            raise SandboxTimeoutError(timeout, process.text(1), process.text(2))
        returncode = transport.get_returncode()
        yield ExecutionResult(
            # A signal's negative return code becomes 128 + the signal, as in the vended environment.
            exit_code=128 - returncode if returncode < 0 else returncode,
            stdout=process.text(1),
            stderr=process.text(2),
        )


def make_managed_shell():
    """The vended shell tool with the harness runtime's 300 s default timeout and result keys.

    It re-declares the vended signature and forwards every call, so the vended error and timeout
    handling still apply; only the default and the result keys (stdout, stderr, exit_code, also in
    the description) differ. A timeout stays a failed result with exit code 124.

    The vended local sandbox runs ``sh -c "cd <cwd> && <command>"`` and returns once the output
    pipes close, and its timeout only fires while that shell still runs, so a background child that
    inherits the pipes would hold the call open. On POSIX a call on an agent without a sandbox of its
    own runs in ``_LocalShell``, which ends the call once the shell exits. A sandbox configured on the
    agent (Docker, SSH, ...) runs the command, as with the vended tool. On every platform, a call
    still open shortly after its timeout fails as that timeout does.
    """
    # Reads the agent's sandbox at call time, as the vended tool does.
    vended = make_shell()
    # Windows keeps the vended environment, which runs PowerShell.
    local = None if os.name == "nt" else make_shell(sandbox=_LocalShell())
    description = vended.tool_spec["description"].replace("output (stdout), error (stderr),", "stdout, stderr,")

    @tool(name=vended.tool_name, description=description, context="tool_context")
    async def shell(command: str, tool_context: ToolContext, timeout: int = 300) -> dict:
        """Executes a shell command and returns its output and exit code.

        Args:
            command: The shell command to execute.
            tool_context: Injected by the framework. Not user-facing.
            timeout: Timeout in seconds (default: 300).
        """
        # The grace lets the vended timeout, which keeps the partial output, end a foreground command.
        deadline = None if timeout is None else timeout + _SHELL_DEADLINE_GRACE_SECONDS
        # Only the agent's host default is replaced; a subclass or any other sandbox was configured.
        host_default = type(tool_context.agent.sandbox) is NotASandboxLocalEnvironment
        run = local if local is not None and host_default else vended
        try:
            result = await asyncio.wait_for(run(command, tool_context, timeout), deadline)
        except SandboxTimeoutError as error:
            # The vended tool appended its partial-output JSON as the message's second line; replace that line.
            message = str(error).split("\n", 1)[0]
            partial = {"stdout": error.stdout, "stderr": error.stderr, "exit_code": 124}
            error.args = (f"{message}\n{json.dumps(partial)}",)
            raise
        except asyncio.TimeoutError:
            # The shell exited but a background child still holds its output pipes (in the vended
            # environment; _LocalShell ends such calls itself), so the vended timeout never fired;
            # fail as it would, without the output the vended call never returned.
            error = SandboxTimeoutError(timeout)
            partial = {"stdout": "", "stderr": "", "exit_code": 124}
            error.args = (f"{error}\n{json.dumps(partial)}",)
            raise error from None
        return {"stdout": result["output"], "stderr": result["error"], "exit_code": result["exit_code"]}

    return shell
{{/if}}
{{#if hasContextOffloader}}


_OFFLOAD_ROOT = os.path.join(tempfile.gettempdir(), "agent", "offloaded")
_RETRIEVAL_TOOL = "retrieve_context"
# Bounds one exempt result: 2x the Agent Skills spec's < 5,000-token SKILL.md guidance; larger ones get a preview.
_EXEMPT_MAX_TOKENS = 10_000


class LineRange(TypedDict):
    """A span of lines to retrieve (1-indexed, inclusive)."""

    start: int
    end: int


class _ContextOffloader(ContextOffloader):
    """``ContextOffloader`` whose retrieval tool is ``retrieve_context``, as in the harness runtime."""

    @property
    def tools(self):
        # The SDK drops its disabled tool only in ``init_agent``; hide it before that too.
        return [agent_tool for agent_tool in super().tools if agent_tool.tool_name == _RETRIEVAL_TOOL]

    @tool(name=_RETRIEVAL_TOOL, context=True)
    async def retrieve_context(
        self,
        reference: str,
        tool_context: ToolContext,
        pattern: str | None = None,
        line_range: LineRange | None = None,
        context_lines: int | None = None,
    ) -> dict | str:
        """Retrieve content that was offloaded from context.

        When a tool result was too large to keep in context, it was stored and replaced with a preview and a
        reference. Use this tool with that reference to access the original content.

        Options:
          - pattern: regex/keyword to find matching lines with context
          - line_range: { start, end } to read a specific span
          - Without pattern/line_range: returns the full original content (use sparingly)

        Examples:
          {"reference": "tu_abc123_0", "pattern": "error"}
          {"reference": "tu_abc123_0", "line_range": {"start": 10, "end": 25}}
          {"reference": "tu_abc123_0"}

        Args:
            reference: The reference key from the offload placeholder.
            pattern: Regex or keyword to grep for. Returns matching lines with context.
            line_range: Line range to extract (1-indexed, inclusive).
            context_lines: Lines of context around each match (default: 5).
            tool_context: Injected by the framework.
        """
        return await self.retrieve_offloaded_content(
            reference=reference,
            tool_context=tool_context,
            pattern=pattern,
            line_range=line_range,
            context_lines=context_lines,
        )


def _make_context_offloader(session_id, exempt_tools):
    """Offload large tool results to disk per session, with ``retrieve_context`` to read them back.

    Results above 1500 tokens are offloaded with a 750-token preview, except those of
    ``retrieve_context`` (which is included) and those of ``exempt_tools`` up to 10,000 tokens.
    Entries are never evicted: a preview in the conversation must stay retrievable for as long as
    the session lasts. A subagent reuses its parent's session storage.
    """
    exempt = frozenset(exempt_tools)
    session_key = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
    return _ContextOffloader(
        storage=LocalFileStorage(os.path.join(_OFFLOAD_ROOT, session_key)),
        max_result_tokens=1500,
        preview_tokens=750,
        include_retrieval_tool=False,
        # The SDK only exempts its own retrieval tool; a retrieval must never be offloaded again.
        should_offload=lambda tool_name, token_count, **kwargs: (
            tool_name != _RETRIEVAL_TOOL and (tool_name not in exempt or token_count > _EXEMPT_MAX_TOKENS)
        ),
        evict_after_cycles=None,
    )
{{/if}}


def _create_harness_agent(*, plugin_tools, plugins, **kwargs):
    """Build a Strands Harness agent with its defaults off; each capability is passed explicitly."""
    return create_harness(
        builtin_tools=[],
        background_tasks=False,
        caching=False,
        context_manager=False,
        session=False,
        skills=False,
        memory=False,
        builtin_plugins=["todos"] if "todo_write" in plugin_tools else [],
        plugins=plugins or None,
        tool_executor=SequentialToolExecutor(),
        callback_handler=None,
        hooks=[_BudgetHook()],
        **kwargs,
    )


def _plugins(session_id, plugin_tools, skill_plugins):
    """The agent's plugins: the context offloader when its tool is enabled, then its skills."""
    plugins = []
    {{#if hasContextOffloader}}
    if _RETRIEVAL_TOOL in plugin_tools:
        # Skill instructions must reach the model whole, not as a preview (up to the exempt ceiling).
        plugins.append(_make_context_offloader(session_id, exempt_tools=["skills"] if skill_plugins else []))
    {{/if}}
    plugins.extend(skill_plugins or [])
    return plugins
{{#if hasSubagent}}


# Built-in tools a subagent may use, alongside the parent's MCP tools.
_SUBAGENT_BUILTIN_TOOL_NAMES = frozenset({{safeJson builtinTools}})


def _add_subagent_tool(parent, *, session_id, skill_plugins, make_conversation_manager):
    """Let the agent delegate a focused subtask to a generalist child.

    The child may use the parent's built-in and MCP tools, gets its own instances of the
    plugins it selects and shares the parent's skills. It has no session manager and cannot delegate
    further. As in the harness runtime, each inherited tool is offered by name.
    """
    inheritable = {
        name: tool
        for name, tool in parent.tool_registry.registry.items()
        if name in _SUBAGENT_BUILTIN_TOOL_NAMES or isinstance(tool, MCPAgentTool)
    }

    def build_child(spec):
        selected = set(spec.tools) if spec.tools is not None else {*inheritable, *_PLUGIN_TOOL_NAMES}
        plugin_tools = selected & _PLUGIN_TOOL_NAMES
        return _create_harness_agent(
            plugin_tools=plugin_tools,
            plugins=_plugins(session_id, plugin_tools, skill_plugins),
            model=spec.model or parent.model,
            # A child on the parent's model also shares its uncached side-call model (summaries).
            aux_model=None if spec.model else parent.aux_model,
            instructions=spec.instructions,
            tools=[tool for name, tool in inheritable.items() if name in selected],
            conversation_manager=make_conversation_manager(),
            name="subagent",
        )

    parent.tool_registry.register_tool(
        make_subagent(
            builder=build_child,
            presets={"generalist": GENERALIST},
            inherited_tools=[*inheritable, *sorted(_PLUGIN_TOOL_NAMES)],
            context=Choice(["none", "all", "no_tools"]),
        )
    )
{{/if}}


def build_session_agent(*, session_id, make_conversation_manager, skill_plugins=None, **kwargs):
    """Build the agent that serves a session, with its plugins and subagent tool."""
    agent = _create_harness_agent(
        plugin_tools=_PLUGIN_TOOL_NAMES,
        plugins=_plugins(session_id, _PLUGIN_TOOL_NAMES, skill_plugins),
        conversation_manager=make_conversation_manager(),
        **kwargs,
    )
    {{#if hasSubagent}}
    # Registered after construction so the child can pick from the MCP tools the agent loaded.
    _add_subagent_tool(
        agent,
        session_id=session_id,
        skill_plugins=skill_plugins,
        make_conversation_manager=make_conversation_manager,
    )
    {{/if}}
    return agent
