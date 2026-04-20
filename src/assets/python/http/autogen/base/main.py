import os
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

{{#if sessionStorageMountPath}}
SESSION_STORAGE_PATH = "{{sessionStorageMountPath}}"

def _safe_resolve(path: str) -> str:
    """Resolve path safely within the storage boundary."""
    resolved = os.path.realpath(os.path.join(SESSION_STORAGE_PATH, path.lstrip("/")))
    if not resolved.startswith(os.path.realpath(SESSION_STORAGE_PATH)):
        raise ValueError(f"Path '{path}' is outside the storage boundary")
    return resolved

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

tools.extend([
    FunctionTool(file_read, description="Read a file from persistent storage. The path is relative to the storage root."),
    FunctionTool(file_write, description="Write content to a file in persistent storage. The path is relative to the storage root."),
    FunctionTool(list_files, description="List files in persistent storage. The directory is relative to the storage root."),
])
{{/if}}

SYSTEM_MESSAGE = """
You are a helpful assistant. Use tools when appropriate.
{{#if sessionStorageMountPath}}
You have persistent storage at {{sessionStorageMountPath}}. Use file tools to read and write files. Data persists across sessions.
{{/if}}
"""

@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")

    # Get MCP Tools
    mcp_tools = await get_streamable_http_mcp_tools()

    # Define an AssistantAgent with the model and tools
    agent = AssistantAgent(
        name="{{ name }}",
        model_client=load_model(),
        tools=tools + mcp_tools,
        system_message=SYSTEM_MESSAGE,
    )

    # Process the user prompt
    prompt = payload.get("prompt", "What can you help me with?")

    # Run the agent
    result = await agent.run(task=prompt)

    # Return result
    return {"result": result.messages[-1].content}


if __name__ == "__main__":
    app.run()
