from strands import Agent, tool
from ag_ui_strands import StrandsAgent
from bedrock_agentcore.runtime import serve_ag_ui
from model.load import load_model
{{#if hasMemory}}
from memory.session import get_memory_session_manager
{{/if}}


@tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers."""
    return a + b


tools = [add_numbers]

{{#if hasMemory}}
def agent_factory():
    cache = {}
    def get_or_create_agent(session_id, user_id):
        key = f"{session_id}/{user_id}"
        if key not in cache:
            cache[key] = Agent(
                model=load_model(),
                session_manager=get_memory_session_manager(session_id, user_id),
                system_prompt="You are a helpful assistant. Use tools when appropriate.",
                tools=tools,
            )
        return cache[key]
    return get_or_create_agent

get_or_create_agent = agent_factory()
agent = get_or_create_agent("default-session", "default-user")
{{else}}
agent = Agent(
    model=load_model(),
    system_prompt="You are a helpful assistant. Use tools when appropriate.",
    tools=tools,
)
{{/if}}

agui_agent = StrandsAgent(
    agent=agent,
    name="{{ name }}",
    description="A helpful assistant",
)

if __name__ == "__main__":
    serve_ag_ui(agui_agent)
