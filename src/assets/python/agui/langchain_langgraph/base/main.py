from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent
from bedrock_agentcore.runtime import AGUIApp
from bedrock_agentcore.runtime.context import RequestContext
from ag_ui.core import (
    RunAgentInput,
    RunStartedEvent,
    RunFinishedEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
)
from model.load import load_model


@tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers."""
    return a + b


model = load_model()
graph = create_react_agent(model, tools=[add_numbers])

app = AGUIApp()


@app.entrypoint
async def handle(input_data: RunAgentInput, context: RequestContext):
    yield RunStartedEvent(thread_id=input_data.thread_id, run_id=input_data.run_id)

    user_text = ""
    if input_data.messages:
        last = input_data.messages[-1]
        if hasattr(last, "content") and last.content:
            user_text = last.content

    result = await graph.ainvoke({"messages": [("user", user_text)]})
    response = result["messages"][-1].content

    msg_id = "msg-1"
    yield TextMessageStartEvent(message_id=msg_id, role="assistant")
    yield TextMessageContentEvent(message_id=msg_id, delta=response)
    yield TextMessageEndEvent(message_id=msg_id)

    yield RunFinishedEvent(thread_id=input_data.thread_id, run_id=input_data.run_id)


if __name__ == "__main__":
    app.run()
