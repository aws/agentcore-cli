import os

os.environ["OTEL_SDK_DISABLED"] = "true"

import uvicorn
from strands import Agent, tool
from ag_ui_strands import StrandsAgent, create_strands_app
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

agui_agent = StrandsAgent(agent=agent, name="{{ name }}", description="A helpful assistant")
app = create_strands_app(agui_agent, path="/invocations", ping_path="/ping")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080)
