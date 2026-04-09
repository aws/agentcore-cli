import os

os.environ["LANGGRAPH_FAST_API"] = "true"

import uvicorn
from typing import Any, List
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from langgraph.graph import StateGraph
from langgraph.graph.message import MessagesState
from langgraph.checkpoint.memory import MemorySaver
from langchain_core.tools import tool
from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint
from model.load import load_model


@tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers."""
    return a + b


model = load_model()


class AgentState(MessagesState):
    tools: List[Any]


def chat_node(state: AgentState):
    bound_model = model.bind_tools(
        [*state.get("tools", []), add_numbers],
        parallel_tool_calls=False,
    )
    response = bound_model.invoke(state["messages"])
    return {"messages": [response]}


builder = StateGraph(AgentState)
builder.add_node("chat", chat_node)
builder.set_entry_point("chat")
builder.set_finish_point("chat")
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
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

add_langgraph_fastapi_endpoint(app=app, agent=agent, path="/invocations")


@app.get("/ping")
async def ping():
    return {"status": "ok"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080)
