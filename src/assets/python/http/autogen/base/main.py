{{#if needsOs}}
import os
{{/if}}
from collections import OrderedDict
from autogen_agentchat.agents import AssistantAgent
from autogen_core.tools import FunctionTool
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model
from mcp_client.client import get_streamable_http_mcp_tools

app = BedrockAgentCoreApp()
log = app.logger


# Define a simple function tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers"""
    return a + b


add_numbers_tool = FunctionTool(
    add_numbers, description="Return the sum of two numbers"
)

# Define a collection of tools used by the model
tools = [add_numbers_tool]

{{#if needsOs}}
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

tools.extend([
    FunctionTool(file_read, description="Read a file from a mounted filesystem. Use the absolute path (e.g. /mnt/tools/data.txt)."),
    FunctionTool(file_write, description="Write a file to a mounted filesystem. Use the absolute path (e.g. /mnt/tools/data.txt)."),
    FunctionTool(list_files, description="List files in a mounted filesystem directory. Use the absolute path (e.g. /mnt/tools)."),
])
{{/if}}

SYSTEM_MESSAGE = """
You are a helpful assistant. Use tools when appropriate.
{{#if needsOs}}
You have access to the following mounted filesystems. Use file_read, file_write, and list_files with full absolute paths:
{{#if sessionStorageMountPath}}- {{sessionStorageMountPath}}: ephemeral session storage (lost when session ends)
{{/if}}{{#each efsMounts}}- {{mountPath}}: EFS persistent storage (persists across sessions and agent restarts)
{{/each}}{{#each s3Mounts}}- {{mountPath}}: S3 Files persistent storage (durable, backed by S3)
{{/each}}{{/if}}
"""

# Reuses one AssistantAgent per session_id so each session keeps its own
# in-process conversation history (best-effort; resets on cold start). Caches up
# to 128 active sessions with LRU eviction (least-recently-used is dropped and
# its history reset).
_agents = OrderedDict()


async def get_or_create_agent(session_id):
    if session_id in _agents:
        _agents.move_to_end(session_id)
        return _agents[session_id]
    if len(_agents) >= 128:
        _agents.popitem(last=False)
    # Get MCP Tools
    mcp_tools = await get_streamable_http_mcp_tools()
    # Re-check after the await: a concurrent first-invocation for the same
    # session_id may have built and stored the agent while we were awaiting.
    # Don't overwrite it (that would orphan the agent the other request is using).
    if session_id not in _agents:
        _agents[session_id] = AssistantAgent(
            name="{{ name }}",
            model_client=load_model(),
            tools=tools + mcp_tools,
            system_message=SYSTEM_MESSAGE,
        )
    _agents.move_to_end(session_id)
    return _agents[session_id]


@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")

    # Process the user prompt
    prompt = payload.get("prompt", "What can you help me with?")
    session_id = getattr(context, "session_id", "default-session")

    # Reuse the per-session agent (preserves conversation history)
    agent = await get_or_create_agent(session_id)

    # Run the agent
    result = await agent.run(task=prompt)

    # Return result
    return {"result": result.messages[-1].content}


if __name__ == "__main__":
    app.run()
