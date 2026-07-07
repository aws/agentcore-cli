import os

os.environ["LANGGRAPH_FAST_API"] = "true"

import uvicorn
from typing import Any, List
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from langgraph.graph import StateGraph, START
from langgraph.graph.message import MessagesState
from langgraph.checkpoint.memory import MemorySaver
from langgraph.prebuilt import ToolNode, tools_condition
from langchain_core.tools import tool
from opentelemetry.instrumentation.langchain import LangchainInstrumentor
from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint
from model.load import load_model

LangchainInstrumentor().instrument()


@tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers."""
    return a + b


backend_tools = [add_numbers]

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

backend_tools.extend([file_read, file_write, list_files])
{{/if}}
model = load_model()


class AgentState(MessagesState):
    tools: List[Any]


def chat_node(state: AgentState):
    bound_model = model.bind_tools(
        [*state.get("tools", []), *backend_tools],
    )
    response = bound_model.invoke(state["messages"])
    return {"messages": [response]}


builder = StateGraph(AgentState)
builder.add_node("chat", chat_node)
builder.add_node("tools", ToolNode(tools=backend_tools))
builder.add_edge(START, "chat")
builder.add_conditional_edges("chat", tools_condition)
builder.add_edge("tools", "chat")
graph = builder.compile(checkpointer=MemorySaver())

agent = LangGraphAgent(
    name="{{ name }}",
    graph=graph,
    description="A helpful assistant",
)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

add_langgraph_fastapi_endpoint(app=app, agent=agent, path="/invocations")


@app.get("/ping")
async def ping():
    return {"status": "healthy"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
