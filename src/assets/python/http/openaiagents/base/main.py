import os
from agents import Agent, Runner, function_tool
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model
{{#if hasGateway}}
from mcp_client.client import get_all_gateway_mcp_servers
{{else}}
from mcp_client.client import get_streamable_http_mcp_client
{{/if}}

app = BedrockAgentCoreApp()
log = app.logger

# Get MCP Server
{{#if hasGateway}}
mcp_servers = get_all_gateway_mcp_servers()
{{else}}
mcp_server = get_streamable_http_mcp_client()
mcp_servers = [mcp_server] if mcp_server else []
{{/if}}

_credentials_loaded = False

def ensure_credentials_loaded():
    global _credentials_loaded
    if not _credentials_loaded:
        load_model()
        _credentials_loaded = True


# Define a simple function tool
@function_tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers"""
    return a + b


tools = [add_numbers]

{{#if sessionStorageMountPath}}
SESSION_STORAGE_PATH = "{{sessionStorageMountPath}}"

def _safe_resolve(path: str) -> str:
    """Resolve path safely within the storage boundary."""
    resolved = os.path.realpath(os.path.join(SESSION_STORAGE_PATH, path.lstrip("/")))
    if not resolved.startswith(os.path.realpath(SESSION_STORAGE_PATH)):
        raise ValueError(f"Path '{path}' is outside the storage boundary")
    return resolved

@function_tool
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

@function_tool
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

@function_tool
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

INSTRUCTIONS = """
You are a helpful assistant. Use tools when appropriate.
{{#if sessionStorageMountPath}}
You have persistent storage at {{sessionStorageMountPath}}. Use file tools to read and write files. Data persists across sessions.
{{/if}}
"""

# Define the agent execution
async def main(query):
    ensure_credentials_loaded()
    try:
        {{#if hasGateway}}
        if mcp_servers:
            agent = Agent(
                name="{{ name }}",
                model="gpt-4.1",
                instructions=INSTRUCTIONS,
                mcp_servers=mcp_servers,
                tools=tools
            )
            result = await Runner.run(agent, query)
            return result
        else:
            agent = Agent(
                name="{{ name }}",
                model="gpt-4.1",
                instructions=INSTRUCTIONS,
                mcp_servers=[],
                tools=tools
            )
            result = await Runner.run(agent, query)
            return result
        {{else}}
        if mcp_servers:
            async with mcp_servers[0] as server:
                active_servers = [server]
                agent = Agent(
                    name="{{ name }}",
                    model="gpt-4.1",
                    instructions=INSTRUCTIONS,
                    mcp_servers=active_servers,
                    tools=tools
                )
                result = await Runner.run(agent, query)
                return result
        else:
            agent = Agent(
                name="{{ name }}",
                model="gpt-4.1",
                instructions=INSTRUCTIONS,
                mcp_servers=[],
                tools=tools
            )
            result = await Runner.run(agent, query)
            return result
        {{/if}}
    except Exception as e:
        log.error(f"Error during agent execution: {e}", exc_info=True)
        raise e


@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")

    # Process the user prompt
    prompt = payload.get("prompt", "What can you help me with?")

    # Run the agent
    result = await main(prompt)

    # Return result
    return {"result": result.final_output}


if __name__ == "__main__":
    app.run()
