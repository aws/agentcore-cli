from typing import Any

from strands import Agent, tool
{{#if hasConfigBundle}}
from strands.hooks import HookProvider, HookRegistry, BeforeInvocationEvent, BeforeToolCallEvent
from bedrock_agentcore.runtime.context import BedrockAgentCoreContext
{{/if}}
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model
{{#if hasGateway}}
from mcp_client.client import get_all_gateway_mcp_clients
{{else}}
from mcp_client.client import get_streamable_http_mcp_client
{{/if}}
{{#if hasMemory}}
from memory.session import get_memory_session_manager
{{/if}}
{{#if sessionStorageMountPath}}
import os
{{/if}}

app = BedrockAgentCoreApp()
log = app.logger

# Define a Streamable HTTP MCP Client
{{#if hasGateway}}
mcp_clients = get_all_gateway_mcp_clients()
{{else}}
mcp_clients = [get_streamable_http_mcp_client()]
{{/if}}

DEFAULT_SYSTEM_PROMPT = """
You are a helpful assistant. Use tools when appropriate.
{{#if sessionStorageMountPath}}
You have persistent storage at {{sessionStorageMountPath}}. Use file tools to read and write files. Data persists across sessions.
{{/if}}
"""

{{#if hasConfigBundle}}
DEFAULT_TOOL_DESC = "Return the sum of two numbers"
{{/if}}

# Define a collection of tools used by the model
tools = []

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

{{#if sessionStorageMountPath}}
SESSION_STORAGE_PATH = "{{sessionStorageMountPath}}"

def _safe_resolve(path: str) -> str:
    """Resolve path safely within the storage boundary."""
    resolved = os.path.realpath(os.path.join(SESSION_STORAGE_PATH, path.lstrip("/")))
    if not resolved.startswith(os.path.realpath(SESSION_STORAGE_PATH)):
        raise ValueError(f"Path '{path}' is outside the storage boundary")
    return resolved

@tool
def file_read(path: str) -> str:
    """Read a file from persistent storage. The path is relative to the storage root."""
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
    """Write content to a file in persistent storage. The path is relative to the storage root."""
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
def list_files(directory: str = "") -> str:
    """List files in persistent storage. The directory is relative to the storage root."""
    try:
        target = _safe_resolve(directory)
        entries = os.listdir(target)
        return "\n".join(entries) if entries else "(empty directory)"
    except ValueError as e:
        return str(e)
    except OSError as e:
        return f"Error listing '{directory}': {e.strerror}"

tools.extend([file_read, file_write, list_files])
{{/if}}

# Add MCP client to tools if available
for mcp_client in mcp_clients:
    if mcp_client:
        tools.append(mcp_client)

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

{{#if hasMemory}}
def agent_factory():
    cache = {}
    def get_or_create_agent(session_id, user_id):
        key = f"{session_id}/{user_id}"
        if key not in cache:
            # Create an agent for the given session_id and user_id
            cache[key] = Agent(
                model=load_model(),
                session_manager=get_memory_session_manager(session_id, user_id),
                system_prompt=DEFAULT_SYSTEM_PROMPT,
                tools=tools{{#if hasConfigBundle}},
                hooks=[ConfigBundleHook()]{{/if}}
            )
        return cache[key]
    return get_or_create_agent
get_or_create_agent = agent_factory()
{{else}}
{{#if hasConfigBundle}}
def create_agent():
    return Agent(
        model=load_model(),
        system_prompt=DEFAULT_SYSTEM_PROMPT,
        tools=tools,
        hooks=[ConfigBundleHook()],
    )
{{else}}
_agent = None

def get_or_create_agent():
    global _agent
    if _agent is None:
        _agent = Agent(
            model=load_model(),
            system_prompt=DEFAULT_SYSTEM_PROMPT,
            tools=tools
        )
    return _agent
{{/if}}
{{/if}}


@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")

{{#if hasMemory}}
    session_id = getattr(context, 'session_id', 'default-session')
    user_id = getattr(context, 'user_id', 'default-user')
    agent = get_or_create_agent(session_id, user_id)
{{else}}
{{#if hasConfigBundle}}
    agent = create_agent()
{{else}}
    agent = get_or_create_agent()
{{/if}}
{{/if}}

    # Execute and format response
    stream = agent.stream_async(payload.get("prompt"))

    async for event in stream:
        # Handle Text parts of the response
        if "data" in event and isinstance(event["data"], str):
            yield event["data"]


if __name__ == "__main__":
    app.run()
