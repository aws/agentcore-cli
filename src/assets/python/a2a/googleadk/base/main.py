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


agent = Agent(
    model=load_model(),
    name="{{ name }}",
    description="A helpful assistant that can use tools.",
    instruction="You are a helpful assistant. Use tools when appropriate.",
    tools=[add_numbers],
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
