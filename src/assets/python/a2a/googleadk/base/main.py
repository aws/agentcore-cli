import os
from google.adk.agents import Agent
from google.adk.a2a.executor.a2a_agent_executor import A2aAgentExecutor
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from a2a.types import AgentCapabilities, AgentCard, AgentSkill
from bedrock_agentcore.runtime import serve_a2a
from model.load import load_model


def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers."""
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
You are a helpful assistant. Use tools when appropriate.
{{#if sessionStorageMountPath}}
You have persistent storage at {{sessionStorageMountPath}}. Use file tools to read and write files. Data persists across sessions.
{{/if}}
"""

agent = Agent(
    model=load_model(),
    name="{{ name }}",
    description="A helpful assistant that can use tools.",
    instruction=AGENT_INSTRUCTION,
    tools=tools,
)

runner = Runner(
    app_name=agent.name,
    agent=agent,
    session_service=InMemorySessionService(),
)

card = AgentCard(
    name=agent.name,
    description=agent.description,
    url="http://localhost:9000/",
    version="0.1.0",
    capabilities=AgentCapabilities(streaming=True),
    skills=[
        AgentSkill(
            id="tools",
            name="tools",
            description="Use tools to help answer questions",
            tags=["tools"],
        )
    ],
    default_input_modes=["text"],
    default_output_modes=["text"],
)

if __name__ == "__main__":
    serve_a2a(A2aAgentExecutor(runner=runner), card)
