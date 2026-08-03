from typing import Any
from collections import OrderedDict
{{#if inlineFunctionTools}}
import json

from strands.tools.tools import PythonAgentTool
from strands.types.tools import ToolResult, ToolUse
{{/if}}
from strands import Agent, tool
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
{{#if hasShell}}
import subprocess
{{/if}}
{{#if hasFileOperations}}
import os
{{/if}}
{{#if hasExecutionLimits}}
from strands.tools.executors import SequentialToolExecutor
from strands.types.exceptions import EventLoopException
from hooks.execution_limits import ExecutionLimitExceeded, ExecutionLimitsHook
{{/if}}
{{#if hasConfigBundle}}
from strands.hooks import HookProvider, HookRegistry, BeforeInvocationEvent, BeforeToolCallEvent
{{/if}}
{{#if truncationStrategy}}
{{#if (eq truncationStrategy "sliding_window")}}
from strands.agent.conversation_manager.sliding_window_conversation_manager import SlidingWindowConversationManager
{{/if}}
{{#if (eq truncationStrategy "summarization")}}
from strands.agent.conversation_manager.summarizing_conversation_manager import SummarizingConversationManager
{{/if}}
{{else}}
from strands.agent.conversation_manager.null_conversation_manager import NullConversationManager
{{/if}}
{{#if hasConfigBundle}}
from bedrock_agentcore.runtime.context import BedrockAgentCoreContext
{{/if}}
{{#if hasBrowser}}
from strands_tools.browser import AgentCoreBrowser
{{/if}}
{{#if hasCodeInterpreter}}
from strands_tools.code_interpreter import AgentCoreCodeInterpreter
{{/if}}
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model
{{#if hasGateway}}
from mcp_client.client import get_all_gateway_mcp_clients
{{/if}}
{{#if remoteMcpTools}}
from mcp_client.client import get_all_remote_mcp_clients
{{/if}}
{{#unless (or hasGateway remoteMcpTools)}}
{{#unless isExportHarness}}
from mcp_client.client import get_streamable_http_mcp_client
{{/unless}}
{{/unless}}
{{#if hasMemory}}
from memory.session import get_memory_session_manager
{{/if}}
{{#unless hasFileOperations}}
{{#if (or needsOs browserIdentifierEnvVar codeInterpreterIdentifierEnvVar (some gitSkills "credentialArn"))}}
import os
{{/if}}
{{/unless}}
{{#if hasPayment}}
from capabilities.payments.payments import create_payments_plugin, PAYMENT_SYSTEM_PROMPT
{{/if}}

app = BedrockAgentCoreApp()
log = app.logger

{{#if (or hasGateway remoteMcpTools)}}
# Define MCP clients for all configured MCP servers (gateways and/or remote MCP)
mcp_clients = []
{{#if hasGateway}}
mcp_clients += get_all_gateway_mcp_clients()
{{/if}}
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
DEFAULT_SYSTEM_PROMPT = """
You are a helpful assistant. Use tools when appropriate.
{{#if needsOs}}{{#unless isExportHarness}}
You have access to the following mounted filesystems. Use file_read, file_write, and list_files with full absolute paths:
{{#if sessionStorageMountPath}}- {{sessionStorageMountPath}}: ephemeral session storage (lost when session ends)
{{/if}}{{#each efsMounts}}- {{mountPath}}: EFS persistent storage (persists across sessions and agent restarts)
{{/each}}{{#each s3Mounts}}- {{mountPath}}: S3 Files persistent storage (durable, backed by S3)
{{/each}}{{/unless}}{{/if}}
"""
{{/if}}

{{#if hasConfigBundle}}
DEFAULT_TOOL_DESC = "Return the sum of two numbers"
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
{{#if hasConfigBundle}}
@tool(description=DEFAULT_TOOL_DESC)
{{else}}
@tool
{{/if}}
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers"""
    return a+b
tools.append(add_numbers)

{{/unless}}
{{/if}}
{{#if hasBrowser}}
{{#if browserIdentifierEnvVar}}
_browser_id = os.getenv("{{browserIdentifierEnvVar}}")
tools.append(AgentCoreBrowser(**({"identifier": _browser_id} if _browser_id else {})).browser)
{{else}}
tools.append(AgentCoreBrowser().browser)
{{/if}}
{{/if}}
{{#if hasCodeInterpreter}}
{{#if codeInterpreterIdentifierEnvVar}}
_code_interpreter_id = os.getenv("{{codeInterpreterIdentifierEnvVar}}")
tools.append(AgentCoreCodeInterpreter(**({"identifier": _code_interpreter_id} if _code_interpreter_id else {})).code_interpreter)
{{else}}
tools.append(AgentCoreCodeInterpreter().code_interpreter)
{{/if}}
{{/if}}
{{#if hasShell}}
@tool
def shell(command: str, timeout: int = 300) -> dict:
    """Execute a bash command and return the results.

    Args:
        command: The bash command to execute
        timeout: Timeout in seconds (default: 300)

    Returns:
        Dict with stdout, stderr, and exit_code
    """
    result = subprocess.run(
        command, shell=True, capture_output=True, text=True, timeout=timeout
    )
    return {"stdout": result.stdout, "stderr": result.stderr, "exit_code": result.returncode}

tools.append(shell)
{{/if}}
{{#if hasFileOperations}}
@tool
def file_operations(
    command: str,
    path: str,
    old_str: str = None,
    new_str: str = None,
    file_text: str = None,
    insert_line: int = None,
    view_range: list = None,
) -> str:
    """Text editor tool for viewing and modifying files.

    Args:
        command: The command to execute ("view", "str_replace", "create", "insert")
        path: Path to the file or directory
        old_str: Text to replace (for str_replace command)
        new_str: Replacement text (for str_replace and insert commands)
        file_text: Content for new file (for create command)
        insert_line: Line number to insert after (for insert command)
        view_range: [start_line, end_line] for viewing specific lines (for view command)

    Returns:
        Result of the operation
    """
    try:
        if command == "view":
            if not os.path.exists(path):
                return f"Error: Path '{path}' does not exist"
            if os.path.isdir(path):
                return "\n".join(os.listdir(path))
            with open(path) as f:
                lines = f.read().splitlines()
            if view_range:
                start, end = view_range
                start_idx = max(0, start - 1)
                end_idx = len(lines) if end == -1 else min(len(lines), end)
                lines = lines[start_idx:end_idx]
                start_num = start_idx + 1
            else:
                start_num = 1
            return "\n".join(f"{start_num + i}: {line}" for i, line in enumerate(lines))
        elif command == "str_replace":
            if old_str is None or new_str is None:
                return "Error: str_replace requires both old_str and new_str parameters"
            if not os.path.exists(path):
                return f"Error: File '{path}' does not exist"
            content = open(path).read()
            if old_str not in content:
                return "Error: Text not found in file"
            count = content.count(old_str)
            if count > 1:
                return f"Error: Text appears {count} times in file. Please be more specific."
            open(path, "w").write(content.replace(old_str, new_str, 1))
            return f"Successfully replaced text in '{path}'"
        elif command == "create":
            if file_text is None:
                return "Error: create requires file_text parameter"
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            open(path, "w").write(file_text)
            return f"Successfully created file '{path}'"
        elif command == "insert":
            if new_str is None or insert_line is None:
                return "Error: insert requires both new_str and insert_line parameters"
            if not os.path.exists(path):
                return f"Error: File '{path}' does not exist"
            lines = open(path).read().splitlines(True)
            if insert_line == 0:
                lines.insert(0, new_str + "\n")
            elif insert_line >= len(lines):
                lines.append(new_str + "\n")
            else:
                lines.insert(insert_line, new_str + "\n")
            open(path, "w").write("".join(lines))
            return f"Successfully inserted text in '{path}' at line {insert_line + 1}"
        else:
            return f"Error: Unknown command '{command}'"
    except Exception as e:
        return f"Error: {e}"

tools.append(file_operations)
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

{{#if (or hasGateway remoteMcpTools)}}
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

{{#if hasConfigBundle}}

class ConfigBundleHook(HookProvider):
    """Injects config bundle values (system prompt, tool descriptions) before each invocation.

    BedrockAgentCoreContext.get_config_bundle() fetches the component configuration
    for the current runtime ARN from the config bundle service. The SDK caches the
    result and refreshes on bundle version changes.
    """

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        registry.add_callback(BeforeInvocationEvent, self._inject_system_prompt)
        registry.add_callback(BeforeToolCallEvent, self._override_tool_desc)

    def _inject_system_prompt(self, event: BeforeInvocationEvent) -> None:
        config = BedrockAgentCoreContext.get_config_bundle()
        prompt = config.get("systemPrompt", DEFAULT_SYSTEM_PROMPT)

        if prompt != event.agent.system_prompt:
            event.agent.system_prompt = prompt

    def _override_tool_desc(self, event: BeforeToolCallEvent) -> None:
        config = BedrockAgentCoreContext.get_config_bundle()
        tool_descs = config.get("toolDescriptions", {})

        tool_name = event.tool_use["name"]
        override = tool_descs.get(tool_name)
        if override and event.selected_tool:
            spec = event.selected_tool.tool_spec
            if spec and "description" in spec:
                spec["description"] = override

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
{{#unless hasPayment}}
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
            cache[key] = Agent(
                model=load_model(),
                session_manager=get_memory_session_manager(session_id, _actor_id),
                conversation_manager=_make_conversation_manager(),
                system_prompt=DEFAULT_SYSTEM_PROMPT,
                tools=tools,
                {{#if hasSkillsFetcher}}
                plugins=skill_plugins or None,
                {{/if}}
                {{#if hasExecutionLimits}}
                tool_executor=SequentialToolExecutor(),
                callback_handler=None,
                {{/if}}
                hooks=[
                    {{#if hasExecutionLimits}}
                    ExecutionLimitsHook(
                        {{#if maxIterations}}max_iterations={{maxIterations}},{{/if}}
                        {{#if maxTokens}}max_tokens={{maxTokens}},{{/if}}
                        {{#if timeoutSeconds}}timeout_seconds={{timeoutSeconds}},{{/if}}
                    ),
                    {{/if}}
                    {{#if hasConfigBundle}}
                    ConfigBundleHook(),
                    {{/if}}
                ],
            )
        return cache[key]
    return get_or_create_agent
get_or_create_agent = agent_factory()
{{/unless}}
{{else}}
{{#unless hasPayment}}
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
        cache[session_id] = Agent(
            model=load_model(),
            system_prompt=DEFAULT_SYSTEM_PROMPT,
            tools=tools,
            conversation_manager=_make_conversation_manager(),
            {{#if hasSkillsFetcher}}
            plugins=skill_plugins or None,
            {{/if}}
            {{#if hasExecutionLimits}}
            tool_executor=SequentialToolExecutor(),
            callback_handler=None,
            {{/if}}
            hooks=[
                {{#if hasExecutionLimits}}
                ExecutionLimitsHook(
                    {{#if maxIterations}}max_iterations={{maxIterations}},{{/if}}
                    {{#if maxTokens}}max_tokens={{maxTokens}},{{/if}}
                    {{#if timeoutSeconds}}timeout_seconds={{timeoutSeconds}},{{/if}}
                ),
                {{/if}}
                {{#if hasConfigBundle}}
                ConfigBundleHook(),
                {{/if}}
            ],
        )
        return cache[session_id]
    return get_or_create_agent
get_or_create_agent = agent_factory()
{{/unless}}
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

{{#if hasPayment}}
    user_id = payload.get("user_id") or getattr(context, "user_id", "default-user")
    instrument_id = payload.get("payment_instrument_id")
    session_id = payload.get("payment_session_id")
    payments_plugin = create_payments_plugin(user_id, instrument_id, session_id)
    plugins = [payments_plugin] if payments_plugin else []
{{/if}}
{{#if hasSkillsFetcher}}
    skill_paths = [{{#each pathSkills}}{{safeJson this}}{{#unless @last}}, {{/unless}}{{/each}}]
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
{{#if hasPayment}}
    mem_session_id = getattr(context, 'session_id', 'default-session')
    {{#if actorId}}
    mem_user_id = "{{actorId}}"
    {{else}}
    mem_user_id = getattr(context, 'user_id', 'default-user')
    {{/if}}
    agent = Agent(
        model=load_model(),
        session_manager=get_memory_session_manager(mem_session_id, mem_user_id),
        system_prompt=DEFAULT_SYSTEM_PROMPT + PAYMENT_SYSTEM_PROMPT,
        tools=tools,
        plugins=plugins{{#if hasSkillsFetcher}} + _skill_plugins{{/if}},{{#if hasConfigBundle}}
        hooks=[ConfigBundleHook()],{{/if}}
    )
{{else}}
    session_id = getattr(context, 'session_id', 'default-session')
    {{#if actorId}}
    user_id = "{{actorId}}"
    {{else}}
    user_id = getattr(context, 'user_id', 'default-user')
    {{/if}}
    agent = get_or_create_agent(session_id, user_id{{#if hasSkillsFetcher}}, _skill_plugins{{/if}})
{{/if}}
{{else}}
{{#if hasPayment}}
    agent = Agent(
        model=load_model(),
        system_prompt=DEFAULT_SYSTEM_PROMPT + PAYMENT_SYSTEM_PROMPT,
        tools=tools,
        plugins=plugins{{#if hasSkillsFetcher}} + _skill_plugins{{/if}},{{#if hasConfigBundle}}
        hooks=[ConfigBundleHook()],{{/if}}
    )
{{else}}
    session_id = getattr(context, 'session_id', 'default-session')
    agent = get_or_create_agent(session_id{{#if hasSkillsFetcher}}, _skill_plugins{{/if}})
{{/if}}
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

    {{#if hasExecutionLimits}}
    timeout_seconds = {{#if timeoutSeconds}}{{timeoutSeconds}}{{else}}None{{/if}}
    timeout_fired = False
    watchdog_task = None
    if timeout_seconds is not None:
        async def _timeout_watchdog():
            nonlocal timeout_fired
            await asyncio.sleep(timeout_seconds)
            timeout_fired = True
            agent.cancel()
        watchdog_task = asyncio.create_task(_timeout_watchdog())

    try:
        {{#if inlineFunctionTools}}
        hit_inline_function = False
        {{/if}}
        async for event in agent.stream_async(
            prompt,
        ):
            if not isinstance(event, dict) or "event" not in event:
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
                return
            {{/if}}

        if timeout_fired:
            yield {"event": {"messageStop": {"stopReason": "timeout_exceeded"}}}
    except EventLoopException as e:
        if isinstance(e.original_exception, ExecutionLimitExceeded):
            yield {"event": {"messageStop": {"stopReason": str(e.original_exception)}}}
            return
        raise
    finally:
        if watchdog_task is not None:
            watchdog_task.cancel()
            try:
                await watchdog_task
            except asyncio.CancelledError:
                pass
    {{else}}
    {{#if inlineFunctionTools}}
    hit_inline_function = False
    {{/if}}
    async for event in agent.stream_async(
        prompt,
    ):
        if not isinstance(event, dict) or "event" not in event:
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
            return
        {{/if}}
    {{/if}}


if __name__ == "__main__":
    app.run()
