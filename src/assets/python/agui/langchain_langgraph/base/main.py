import uvicorn
from langchain_core.tools import tool
from langgraph.prebuilt import create_react_agent
from ag_ui_langgraph import LangGraphAGUIServer
from model.load import load_model


@tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers."""
    return a + b


model = load_model()
agent = create_react_agent(model, tools=[add_numbers])
agui_server = LangGraphAGUIServer(agent)

if __name__ == "__main__":
    uvicorn.run(agui_server.app, host="0.0.0.0", port=8080)
