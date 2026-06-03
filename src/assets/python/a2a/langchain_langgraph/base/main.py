{{#if needsOs}}
import os
{{/if}}
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

SYSTEM_PROMPT = """
You are a helpful assistant. Use tools when appropriate.
{{#if needsOs}}
You have access to the following mounted filesystems. Use file_read, file_write, and list_files with full absolute paths:
{{#if sessionStorageMountPath}}- {{sessionStorageMountPath}}: ephemeral session storage (lost when session ends)
{{/if}}{{#each efsMounts}}- {{mountPath}}: EFS persistent storage (persists across sessions and agent restarts)
{{/each}}{{#each s3Mounts}}- {{mountPath}}: S3 Files persistent storage (durable, backed by S3)
{{/each}}{{/if}}
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
