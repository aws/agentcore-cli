{{#if needsOs}}
import os
{{/if}}
from typing import Any

from langchain_core.messages import HumanMessage{{#if hasConfigBundle}}, SystemMessage{{/if}}
from langgraph.prebuilt import create_react_agent
from langchain.tools import tool
{{#if hasConfigBundle}}
from langchain_core.callbacks import BaseCallbackHandler
from bedrock_agentcore.runtime.context import BedrockAgentCoreContext
{{/if}}
from opentelemetry.instrumentation.langchain import LangchainInstrumentor
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model
{{#if hasGateway}}
from mcp_client.client import get_all_gateway_mcp_client
{{else}}
from mcp_client.client import get_streamable_http_mcp_client
{{/if}}

LangchainInstrumentor().instrument()

app = BedrockAgentCoreApp()
log = app.logger

_llm = None

def get_or_create_model():
    global _llm
    if _llm is None:
        _llm = load_model()
    return _llm


DEFAULT_SYSTEM_PROMPT = """
You are a helpful assistant. Use tools when appropriate.
{{#if needsOs}}
You have access to the following mounted filesystems. Use file_read, file_write, and list_files with full absolute paths:
{{#if sessionStorageMountPath}}- {{sessionStorageMountPath}}: ephemeral session storage (lost when session ends)
{{/if}}{{#each efsMounts}}- {{mountPath}}: EFS persistent storage (persists across sessions and agent restarts)
{{/each}}{{#each s3Mounts}}- {{mountPath}}: S3 Files persistent storage (durable, backed by S3)
{{/each}}{{/if}}
"""


# Define a simple function tool
@tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers"""
    return a + b


# Define a collection of tools used by the model
tools = [add_numbers]

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
{{/if}}

{{#if hasConfigBundle}}

class ConfigBundleCallback(BaseCallbackHandler):
    """Injects config bundle values into LangGraph agent at runtime.

    BedrockAgentCoreContext.get_config_bundle() fetches the component configuration
    for the current runtime ARN from the config bundle service. The SDK caches the
    result and refreshes on bundle version changes.
    """

    def on_chain_start(self, serialized: dict, inputs: dict, **kwargs: Any) -> None:
        config = BedrockAgentCoreContext.get_config_bundle()
        prompt = config.get("systemPrompt", DEFAULT_SYSTEM_PROMPT)

        messages = inputs.get("messages", [])
        if messages and isinstance(messages[0], SystemMessage):
            messages[0] = SystemMessage(content=prompt)
        else:
            messages.insert(0, SystemMessage(content=prompt))
        inputs["messages"] = messages

{{/if}}

@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")

    # Get MCP Client
    {{#if hasGateway}}
    mcp_client = get_all_gateway_mcp_client()
    {{else}}
    mcp_client = get_streamable_http_mcp_client()
    {{/if}}

    # Load MCP Tools
    mcp_tools = []
    if mcp_client:
        mcp_tools = await mcp_client.get_tools()

    # Define the agent using create_react_agent
{{#if hasConfigBundle}}
    graph = create_react_agent(get_or_create_model(), tools=mcp_tools + tools, prompt=DEFAULT_SYSTEM_PROMPT)
    callback = ConfigBundleCallback()

    # Process the user prompt
    prompt = payload.get("prompt", "What can you help me with?")
    log.info(f"Agent input: {prompt}")

    # Run the agent with config bundle callback
    result = await graph.ainvoke(
        {"messages": [HumanMessage(content=prompt)]},
        config={"callbacks": [callback]},
    )
{{else}}
    graph = create_react_agent(get_or_create_model(), tools=mcp_tools + tools, prompt=DEFAULT_SYSTEM_PROMPT)

    # Process the user prompt
    prompt = payload.get("prompt", "What can you help me with?")
    log.info(f"Agent input: {prompt}")

    # Run the agent
    result = await graph.ainvoke({"messages": [HumanMessage(content=prompt)]})
{{/if}}

    # Return result
    output = result["messages"][-1].content
    log.info(f"Agent output: {output}")
    return {"result": output}


if __name__ == "__main__":
    app.run()
