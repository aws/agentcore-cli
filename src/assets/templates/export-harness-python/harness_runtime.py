"""Builds the agent the way the harness does, and bounds it by the invocation's limits."""

{{#if hasContextOffloader}}
import hashlib
import os
import tempfile

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
{{#if hasContextOffloader}}
from strands.vended_plugins.context_offloader import ContextOffloader
{{/if}}
from strands_harness import create_harness
{{#if hasSubagent}}
from strands_harness.tools import Choice, make_subagent
from strands_harness.tools.subagent import GENERALIST
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
{{#if hasContextOffloader}}


_OFFLOAD_ROOT = os.path.join(tempfile.gettempdir(), "agent", "offloaded")


def _make_context_offloader(session_id):
    """Offload large tool results to disk per session, with a tool to read them back.

    Entries are never evicted: a preview in the conversation must stay retrievable for as long
    as the session lasts. A subagent reuses its parent's session storage.
    """
    session_key = hashlib.sha256(session_id.encode("utf-8")).hexdigest()
    return ContextOffloader(
        storage=LocalFileStorage(os.path.join(_OFFLOAD_ROOT, session_key)),
        max_result_tokens=1500,
        preview_tokens=750,
        include_retrieval_tool=True,
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
    """The agent's plugins: its skills, plus the context offloader when its tool is enabled."""
    plugins = list(skill_plugins or [])
    {{#if hasContextOffloader}}
    if "retrieve_offloaded_content" in plugin_tools:
        plugins.append(_make_context_offloader(session_id))
    {{/if}}
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
