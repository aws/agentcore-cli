import uvicorn
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent
from copilotkit.langgraph import copilotkit_messages_to_langchain
from langgraph_a2a import LangGraphA2AServer
from model.load import load_model


@tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers."""
    return a + b


model = load_model()
agent = create_react_agent(model, tools=[add_numbers])
a2a_server = LangGraphA2AServer(agent)

if __name__ == "__main__":
    uvicorn.run(a2a_server.app, host="0.0.0.0", port=9000)
