"""Builds the agent the way the harness does, and bounds it by the invocation's limits."""

{{#if hasContextOffloader}}
import hashlib
{{/if}}
{{#if hasShell}}
import json
{{/if}}
{{#if hasContextOffloader}}
import os
import tempfile
{{/if}}
{{#if (or hasContextOffloader hasShell)}}

from strands import {{#if hasShell}}SandboxTimeoutError, {{/if}}ToolContext, tool
{{/if}}
from strands.hooks import AfterModelCallEvent, BeforeModelCallEvent, HookProvider
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


class InvocationBudget:
    """One budget shared by the agent and every subagent it runs within an invocation.

    Each model call reserves an iteration and adds its token usage, so limits and the reported
    usage cover the whole delegation tree.
    """

    def __init__(self):
        self.iterations = 0
        self.completed_calls = 0
        self.usage = dict.fromkeys(_USAGE_FIELDS + _CACHE_USAGE_FIELDS, 0)
        self.latency_ms = 0

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
        usage = metadata.get("usage")
        if not isinstance(usage, dict):
            return
        for field in _USAGE_FIELDS + _CACHE_USAGE_FIELDS:
            if isinstance(usage.get(field), (int, float)):
                self.usage[field] += int(usage[field])
        latency_ms = (metadata.get("metrics") or {}).get("latencyMs")
        if isinstance(latency_ms, (int, float)):
            self.latency_ms += int(latency_ms)
        self.completed_calls += 1

    def metadata_event(self):
        """The invocation-total usage, reported once in place of per-call metadata."""
        if not self.completed_calls:
            return None
        usage = {field: self.usage[field] for field in _USAGE_FIELDS}
        usage.update({field: self.usage[field] for field in _CACHE_USAGE_FIELDS if self.usage[field]})
        return {"event": {"metadata": {"usage": usage, "metrics": {"latencyMs": self.latency_ms}}}}


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


def make_managed_shell():
    """The vended shell tool with the harness runtime's 300 s default timeout and result keys.

    It re-declares the vended signature and forwards every call, so the vended error and timeout
    handling still apply; only the default and the result keys (stdout, stderr, exit_code, also in
    the description) differ. A timeout stays a failed result with exit code 124.
    """
    vended = make_shell()
    description = vended.tool_spec["description"].replace("output (stdout), error (stderr),", "stdout, stderr,")

    @tool(name=vended.tool_name, description=description, context="tool_context")
    async def shell(command: str, tool_context: ToolContext, timeout: int = 300) -> dict:
        """Executes a shell command and returns its output and exit code.

        Args:
            command: The shell command to execute.
            tool_context: Injected by the framework. Not user-facing.
            timeout: Timeout in seconds (default: 300).
        """
        try:
            result = await vended(command, tool_context, timeout)
        except SandboxTimeoutError as error:
            # The vended tool appended its partial-output JSON as the message's second line; replace that line.
            message = str(error).split("\n", 1)[0]
            partial = {"stdout": error.stdout, "stderr": error.stderr, "exit_code": 124}
            error.args = (f"{message}\n{json.dumps(partial)}",)
            raise
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
