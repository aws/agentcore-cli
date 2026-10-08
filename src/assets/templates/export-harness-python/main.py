from typing import Any
from collections import OrderedDict
{{#if inlineFunctionTools}}
import json

from strands.tools.tools import PythonAgentTool
from strands.types.tools import ToolResult, ToolUse
{{/if}}
from strands.types.exceptions import EventLoopException
{{#if (or hasShell hasWebFetch)}}
from strands.vended_tools import {{#if hasShell}}make_shell{{#if hasWebFetch}}, {{/if}}{{/if}}{{#if hasWebFetch}}make_web_fetch{{/if}}
{{/if}}
{{#if harnessFileTools}}
from strands_harness.tools import {{#each harnessFileTools}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
{{/if}}
{{#if hasSkillsFetcher}}
from strands import AgentSkills
{{#if hasFetchedSkills}}
from skills.fetcher import resolve_s3_skills, resolve_git_skills
{{/if}}
{{#if (some gitSkills "credentialArn")}}
from bedrock_agentcore.services.identity import IdentityClient
{{/if}}
{{/if}}
import asyncio
{{#if timeoutSeconds}}
import threading
{{/if}}
{{#if hasFileOperations}}
import os
{{/if}}
{{#if truncationStrategy}}
{{#if (eq truncationStrategy "sliding_window")}}
from strands.agent.conversation_manager import SlidingWindowConversationManager
{{/if}}
{{#if (eq truncationStrategy "summarization")}}
from strands.agent.conversation_manager.summarizing_conversation_manager import SummarizingConversationManager
{{/if}}
{{else}}
from strands.agent.conversation_manager.null_conversation_manager import NullConversationManager
{{/if}}
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from harness_runtime import InvocationBudget, LimitExceeded, build_session_agent
from model.load import load_model
{{#if remoteMcpTools}}
from mcp_client.client import get_all_remote_mcp_clients
{{/if}}
{{#unless remoteMcpTools}}
{{#unless isExportHarness}}
from mcp_client.client import get_streamable_http_mcp_client
{{/unless}}
{{/unless}}
{{#if hasMemory}}
from memory.session import get_memory_session_manager
{{/if}}
{{#unless hasFileOperations}}
{{#if (or needsOs (some gitSkills "credentialArn"))}}
import os
{{/if}}
{{/unless}}

app = BedrockAgentCoreApp()
log = app.logger

{{#if remoteMcpTools}}
# Define MCP clients for all configured MCP servers (gateways and/or remote MCP)
mcp_clients = []
{{#if remoteMcpTools}}
mcp_clients += get_all_remote_mcp_clients()
{{/if}}
{{else}}
{{#unless isExportHarness}}
# Define a Streamable HTTP MCP Client
mcp_clients = [get_streamable_http_mcp_client()]
{{/unless}}
{{/if}}

{{#if systemPromptText}}
DEFAULT_SYSTEM_PROMPT = """{{escapePyStr systemPromptText}}"""
{{else}}
# No system prompt is set, so create_harness() applies the Strands Harness contract prompt.
{{/if}}


# Define a collection of tools used by the model
tools = []

{{#if inlineFunctionTools}}
# Inline function tools — stop the agent loop so the tool call streams back to the caller
def _make_inline_tool(name: str, spec: dict) -> PythonAgentTool:
    def _handler(tool: ToolUse, **kwargs: Any) -> ToolResult:
        kwargs.get("request_state", {})["stop_event_loop"] = True
        return {"toolUseId": tool["toolUseId"], "status": "success", "content": [{"text": " "}]}
    _handler.__name__ = name
    return PythonAgentTool(tool_name=name, tool_spec=spec, tool_func=_handler)

{{#each inlineFunctionTools}}
_INLINE_SPEC_{{snakeCase name}} = {
    "name": "{{name}}",
    "description": {{safeJson description}},
    "inputSchema": {"json": json.loads({{pyJsonStr inputSchema}}) },
}
tools.append(_make_inline_tool("{{name}}", _INLINE_SPEC_{{snakeCase name}}))
{{/each}}

_INLINE_FUNCTION_NAMES = { {{#each inlineFunctionTools}}"{{name}}"{{#unless @last}}, {{/unless}}{{/each}} }

{{else}}
_INLINE_FUNCTION_NAMES = set()

{{#unless isExportHarness}}
# Define a simple function tool
@tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers"""
    return a+b
tools.append(add_numbers)

{{/unless}}
{{/if}}
{{#if builtinTools}}
# Built-in tools selected by allowedTools.
{{#if hasShell}}
tools.append(make_shell())
{{/if}}
{{#each harnessFileTools}}
tools.append({{this}})
{{/each}}
{{#if hasWebFetch}}
tools.append(make_web_fetch(mode="markdown"))
{{/if}}
{{/if}}
{{#if needsOs}}{{#unless isExportHarness}}
_MOUNT_PATHS = [
    {{#if sessionStorageMountPath}}"{{sessionStorageMountPath}}",{{/if}}
    {{#each efsMounts}}"{{mountPath}}",{{/each}}
    {{#each s3Mounts}}"{{mountPath}}",{{/each}}
]

def _safe_resolve(path: str) -> str:
    resolved = os.path.realpath(path)
    if not any(resolved == os.path.realpath(m) or resolved.startswith(os.path.realpath(m) + os.sep) for m in _MOUNT_PATHS):
        raise ValueError(f"Path '{path}' is not within any configured mount ({', '.join(_MOUNT_PATHS)})")
    return resolved

@tool
def file_read(path: str) -> str:
    """Read a file from a mounted filesystem. Use the absolute path (e.g. /mnt/tools/data.txt)."""
    try:
        full_path = _safe_resolve(path)
        with open(full_path) as f:
            return f.read()
    except ValueError as e:
        return str(e)
    except OSError as e:
        return f"Error reading '{path}': {e.strerror}"

@tool
def file_write(path: str, content: str) -> str:
    """Write a file to a mounted filesystem. Use the absolute path (e.g. /mnt/tools/data.txt)."""
    try:
        full_path = _safe_resolve(path)
        parent = os.path.dirname(full_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(full_path, "w") as f:
            f.write(content)
        return f"Written to {path}"
    except ValueError as e:
        return str(e)
    except OSError as e:
        return f"Error writing '{path}': {e.strerror}"

@tool
def list_files(path: str) -> str:
    """List files in a mounted filesystem directory. Use the absolute path (e.g. /mnt/tools)."""
    try:
        full_path = _safe_resolve(path)
        entries = os.listdir(full_path)
        return "\n".join(entries) if entries else "(empty directory)"
    except ValueError as e:
        return str(e)
    except OSError as e:
        return f"Error listing '{path}': {e.strerror}"

tools.extend([file_read, file_write, list_files])
{{/unless}}{{/if}}

{{#if remoteMcpTools}}
# Add MCP clients to tools
for mcp_client in mcp_clients:
    if mcp_client:
        tools.append(mcp_client)
{{else}}
{{#unless isExportHarness}}
# Add MCP client to tools if available
for mcp_client in mcp_clients:
    if mcp_client:
        tools.append(mcp_client)
{{/unless}}
{{/if}}


def _make_conversation_manager():
{{#if truncationStrategy}}
{{#if (eq truncationStrategy "sliding_window")}}
{{#if truncationConfig}}
    return SlidingWindowConversationManager(**{{safeJson truncationConfig}}, per_turn=True)
{{else}}
    return SlidingWindowConversationManager(per_turn=True)
{{/if}}
{{else}}
{{#if truncationConfig}}
    return SummarizingConversationManager(**{{safeJson truncationConfig}})
{{else}}
    return SummarizingConversationManager()
{{/if}}
{{/if}}
{{else}}
    return NullConversationManager()
{{/if}}

{{#if hasMemory}}
def agent_factory():
    cache = {}
    def get_or_create_agent(session_id, user_id{{#if hasSkillsFetcher}}, skill_plugins=None{{/if}}):
        {{#if actorId}}
        _actor_id = "{{actorId}}"
        {{else}}
        _actor_id = user_id
        {{/if}}
        key = f"{session_id}/{_actor_id}"
        if key not in cache:
            cache[key] = build_session_agent(
                session_id=session_id,
                make_conversation_manager=_make_conversation_manager,
                model=load_model(),
                session_manager=get_memory_session_manager(session_id, _actor_id),
                {{#if systemPromptText}}
                system_prompt=DEFAULT_SYSTEM_PROMPT,
                {{/if}}
                tools=tools,
                {{#if hasSkillsFetcher}}
                skill_plugins=skill_plugins,
                {{/if}}
            )
        return cache[key]
    return get_or_create_agent
get_or_create_agent = agent_factory()
{{else}}
# Reuses one Agent per session_id so each session keeps its own in-process
# conversation history (best-effort; resets on cold start). The cache is bounded
# to 128 sessions with LRU eviction (least-recently-used is dropped and its
# history reset) so a single process serving many sessions cannot leak history
# between them or grow without limit. For durable history, attach a session manager.
def agent_factory():
    cache = OrderedDict()
    def get_or_create_agent(session_id{{#if hasSkillsFetcher}}, skill_plugins=None{{/if}}):
        if session_id in cache:
            cache.move_to_end(session_id)
            return cache[session_id]
        if len(cache) >= 128:
            cache.popitem(last=False)
        cache[session_id] = build_session_agent(
            session_id=session_id,
            make_conversation_manager=_make_conversation_manager,
            model=load_model(),
            {{#if systemPromptText}}
            system_prompt=DEFAULT_SYSTEM_PROMPT,
            {{/if}}
            tools=tools,
            {{#if hasSkillsFetcher}}
            skill_plugins=skill_plugins,
            {{/if}}
        )
        return cache[session_id]
    return get_or_create_agent
get_or_create_agent = agent_factory()
{{/if}}


def strip_trailing_tool_use(messages: Any) -> list[dict]:
    """Strip toolUse blocks from the tail until the last message has none."""
    if not isinstance(messages, list):
        raise ValueError("messages must be a list")

    messages = list(messages)
    while messages:
        last = messages[-1]
        if not isinstance(last, dict):
            raise ValueError("each message must be an object")
        original_content = last.get("content", [])
        if not isinstance(original_content, list) or not all(isinstance(block, dict) for block in original_content):
            raise ValueError("each message content value must be a list of content blocks")

        content = [block for block in original_content if "toolUse" not in block]
        if len(content) == len(original_content):
            break
        if content:
            messages[-1] = {**last, "content": content}
            break
        messages.pop()

    return messages


def _extract_prompt(payload: dict):
    """Accept validated harness messages, tool results, or a plain prompt string."""
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    if "messages" in payload:
        return strip_trailing_tool_use(payload["messages"])
    if "tool_results" in payload:
        tool_results = payload["tool_results"]
        if not isinstance(tool_results, list) or not all(
            isinstance(tool_result, dict) and isinstance(tool_result.get("toolUseId"), str)
            for tool_result in tool_results
        ):
            raise ValueError("tool_results must contain objects with a toolUseId string")
        return [{"role": "user", "content": [{"toolResult": {
            "toolUseId": tr["toolUseId"],
            "status": tr.get("status", "success"),
            "content": tr.get("content", []),
        }} for tr in tool_results]}]
    prompt = payload.get("prompt", "")
    if not isinstance(prompt, str):
        raise ValueError("prompt must be a string")
    return prompt


def _has_inline_function_call(messages) -> bool:
    """Return True if messages contains an assistant toolUse for an inline function tool."""
    if not _INLINE_FUNCTION_NAMES or not isinstance(messages, list):
        return False
    for msg in messages:
        if msg.get("role") == "assistant":
            for block in msg.get("content", []):
                if isinstance(block, dict) and block.get("toolUse", {}).get("name") in _INLINE_FUNCTION_NAMES:
                    return True
    return False


def _is_inline_function_call(event: dict) -> bool:
    """Check if a contentBlockStart event is for an inline function tool."""
    if not _INLINE_FUNCTION_NAMES:
        return False
    cbs = event.get("contentBlockStart", {})
    start = cbs.get("start", {})
    tool_use = start.get("toolUse") if isinstance(start, dict) else None
    return tool_use is not None and tool_use.get("name") in _INLINE_FUNCTION_NAMES



@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")

{{#if hasSkillsFetcher}}
    skill_paths = []
    {{#if s3Skills}}
    s3_skill_sources = [{{#each s3Skills}}{{safeJson this}}{{#unless @last}}, {{/unless}}{{/each}}]
    skill_paths.extend(await asyncio.to_thread(resolve_s3_skills, s3_skill_sources, None))
    {{/if}}
    {{#if gitSkills}}
    git_skill_sources = [
        {{#each gitSkills}}
        dict(url={{safeJson this.url}}{{#if this.path}}, path={{safeJson this.path}}{{/if}}{{#if this.credentialArn}}, credentialArn={{safeJson this.credentialArn}}{{#if this.username}}, username={{safeJson this.username}}{{/if}}{{/if}}),
        {{/each}}
    ]
    {{#if (some gitSkills "credentialArn")}}
    _git_identity_client = IdentityClient(os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1")))
    {{else}}
    _git_identity_client = None
    {{/if}}
    skill_paths.extend(await asyncio.to_thread(resolve_git_skills, git_skill_sources, _git_identity_client))
    {{/if}}
    _skill_plugins = [AgentSkills(skills=skill_paths)] if skill_paths else []
{{/if}}

{{#if hasMemory}}
    session_id = getattr(context, 'session_id', 'default-session')
    {{#if actorId}}
    user_id = "{{actorId}}"
    {{else}}
    user_id = getattr(context, 'user_id', 'default-user')
    {{/if}}
    agent = get_or_create_agent(session_id, user_id{{#if hasSkillsFetcher}}, _skill_plugins{{/if}})
{{else}}
    session_id = getattr(context, 'session_id', 'default-session')
    agent = get_or_create_agent(session_id{{#if hasSkillsFetcher}}, _skill_plugins{{/if}})
{{/if}}

    prompt = _extract_prompt(payload)

    {{#if inlineFunctionTools}}
    # If Turn 2 carries the harness-style assistant(toolUse)+user(toolResult) pair,
    # strip the placeholder turn Strands stored during Turn 1 so the real toolResult
    # is injected cleanly — same protocol as the harness runtime.
    if _has_inline_function_call(prompt):
        msgs = agent.messages
        if len(msgs) >= 2 and any("toolResult" in b for b in msgs[-1].get("content", [])):
            del msgs[-2:]
    {{/if}}

    budget = InvocationBudget()
    cancel_signal = {{#if timeoutSeconds}}threading.Event(){{else}}None{{/if}}
    timeout_fired = False
    watchdog_task = None
    {{#if timeoutSeconds}}
    async def _timeout_watchdog():
        nonlocal timeout_fired
        await asyncio.sleep({{timeoutSeconds}})
        timeout_fired = True
        cancel_signal.set()
    watchdog_task = asyncio.create_task(_timeout_watchdog())
    {{/if}}

    try:
        {{#if inlineFunctionTools}}
        hit_inline_function = False
        inline_handoff = False
        {{/if}}
        try:
            async for event in agent.stream_async(
                prompt, cancel_signal=cancel_signal, invocation_state={"budget": budget}
            ):
                {{#if inlineFunctionTools}}
                if inline_handoff and "metadata" not in (event.get("event") or {}):
                    break
                {{/if}}
                if not isinstance(event, dict) or "event" not in event:
                    continue
                if "metadata" in event["event"]:
                    {{#if inlineFunctionTools}}
                    if inline_handoff:
                        # The loop stops before the model-call hook records this turn's usage.
                        budget.after_model_call(event["event"]["metadata"])
                    {{/if}}
                    {{#if hasSubagent}}
                    # Replaced by the invocation total, which includes subagent usage.
                    {{else}}
                    yield event
                    {{/if}}
                    {{#if inlineFunctionTools}}
                    if inline_handoff:
                        break
                    {{/if}}
                    continue
                cbs = event["event"].get("contentBlockStart")
                if cbs is not None and not cbs.get("start"):
                    continue
                {{#if inlineFunctionTools}}
                if not hit_inline_function:
                    hit_inline_function = _is_inline_function_call(event["event"])
                {{/if}}
                yield event
                {{#if inlineFunctionTools}}
                if hit_inline_function and "messageStop" in event["event"]:
                    # Hand the inline tool call to the caller before the agent runs it. Stop once
                    # this turn's usage arrives, which precedes the tool running.
                    inline_handoff = True
                {{/if}}
        except EventLoopException as e:
            if not isinstance(e.original_exception, LimitExceeded):
                raise
            yield {"event": {"messageStop": {"stopReason": e.original_exception.stop_reason}}}
        else:
            if timeout_fired:
                yield {"event": {"messageStop": {"stopReason": "timeout_exceeded"}}}
        {{#if hasSubagent}}
        metadata = budget.metadata_event()
        if metadata is not None:
            yield metadata
        {{/if}}
    finally:
        if watchdog_task is not None:
            watchdog_task.cancel()
            try:
                await watchdog_task
            except asyncio.CancelledError:
                pass

if __name__ == "__main__":
    app.run()
