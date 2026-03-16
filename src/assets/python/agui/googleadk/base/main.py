import uvicorn
from google.adk.agents import Agent
from ag_ui_google_adk import GoogleADKAGUIServer
from model.load import load_model


def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers."""
    return a + b


agent = Agent(
    model=load_model(),
    name="{{ name }}",
    instruction="You are a helpful assistant. Use tools when appropriate.",
    tools=[add_numbers],
)

agui_server = GoogleADKAGUIServer(agent)

if __name__ == "__main__":
    uvicorn.run(agui_server.app, host="0.0.0.0", port=8080)
