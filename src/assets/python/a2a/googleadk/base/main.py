import uvicorn
from google.adk.agents import Agent
from google.adk.a2a import A2AServer
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

a2a_server = A2AServer(agent)

if __name__ == "__main__":
    uvicorn.run(a2a_server.app, host="0.0.0.0", port=9000)
