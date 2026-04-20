import os
from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model
{{#if hasGateway}}
from mcp_client.client import get_all_gateway_mcp_toolsets
{{else}}
from mcp_client.client import get_streamable_http_mcp_client
{{/if}}

app = BedrockAgentCoreApp()
log = app.logger

APP_NAME = "{{ name }}"

# https://google.github.io/adk-docs/agents/models/
MODEL_ID = "gemini-2.5-flash"


# Define a simple function tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers"""
    return a + b


# Define a collection of tools used by the model
tools = [add_numbers]

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

tools.extend([file_read, file_write, list_files])
{{/if}}

AGENT_INSTRUCTION = """
I can answer your questions using the knowledge I have!
{{#if sessionStorageMountPath}}
You have persistent storage at {{sessionStorageMountPath}}. Use file tools to read and write files. Data persists across sessions.
{{/if}}
"""

# Get MCP Toolset
{{#if hasGateway}}
mcp_toolset = get_all_gateway_mcp_toolsets()
{{else}}
mcp_client = get_streamable_http_mcp_client()
mcp_toolset = [mcp_client] if mcp_client else []
{{/if}}

_credentials_loaded = False

def ensure_credentials_loaded():
    global _credentials_loaded
    if not _credentials_loaded:
        load_model()
        _credentials_loaded = True


# Agent Definition
agent = Agent(
    model=MODEL_ID,
    name="{{ name }}",
    description="Agent to answer questions",
    instruction=AGENT_INSTRUCTION,
    tools=mcp_toolset + tools,
)


# Session and Runner
async def setup_session_and_runner(user_id, session_id):
    ensure_credentials_loaded()
    session_service = InMemorySessionService()
    session = await session_service.create_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id
    )
    runner = Runner(agent=agent, app_name=APP_NAME, session_service=session_service)
    return session, runner


# Agent Interaction
async def call_agent_async(query, user_id, session_id):
    content = types.Content(role="user", parts=[types.Part(text=query)])
    session, runner = await setup_session_and_runner(user_id, session_id)
    events = runner.run_async(
        user_id=user_id, session_id=session.id, new_message=content
    )

    final_response = None
    async for event in events:
        if event.is_final_response():
            final_response = event.content.parts[0].text

    return final_response


@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")

    # Process the user prompt
    prompt = payload.get("prompt", "What can you help me with?")
    session_id = getattr(context, "session_id", "default_session")
    user_id = payload.get("user_id", "default_user")

    # Run the agent
    result = await call_agent_async(prompt, user_id, session_id)

    # Return result
    return {"result": result}


if __name__ == "__main__":
    app.run()
