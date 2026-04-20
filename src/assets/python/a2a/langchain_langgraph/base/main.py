import os
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent
from opentelemetry.instrumentation.langchain import LangchainInstrumentor
from a2a.server.agent_execution import AgentExecutor, RequestContext
from a2a.server.events import EventQueue
from a2a.server.tasks import TaskUpdater
from a2a.types import AgentCapabilities, AgentCard, AgentSkill, Part, TextPart
from a2a.utils import new_task
from bedrock_agentcore.runtime import serve_a2a
from model.load import load_model

LangchainInstrumentor().instrument()


@tool
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

SYSTEM_PROMPT = """
You are a helpful assistant. Use tools when appropriate.
{{#if sessionStorageMountPath}}
You have persistent storage at {{sessionStorageMountPath}}. Use file tools to read and write files. Data persists across sessions.
{{/if}}
"""

model = load_model()
graph = create_react_agent(model, tools=tools, prompt=SYSTEM_PROMPT)


class LangGraphA2AExecutor(AgentExecutor):
    """Wraps a LangGraph CompiledGraph as an a2a-sdk AgentExecutor."""

    def __init__(self, graph):
        self.graph = graph

    async def execute(self, context: RequestContext, event_queue: EventQueue) -> None:
        task = context.current_task or new_task(context.message)
        if not context.current_task:
            await event_queue.enqueue_event(task)
        updater = TaskUpdater(event_queue, task.id, task.context_id)

        user_text = context.get_user_input()
        result = await self.graph.ainvoke({"messages": [("user", user_text)]})
        response = result["messages"][-1].content

        await updater.add_artifact([Part(root=TextPart(text=response))])
        await updater.complete()

    async def cancel(self, context: RequestContext, event_queue: EventQueue) -> None:
        pass


card = AgentCard(
    name="{{ name }}",
    description="A LangGraph agent on Bedrock AgentCore",
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
    serve_a2a(LangGraphA2AExecutor(graph), card)
