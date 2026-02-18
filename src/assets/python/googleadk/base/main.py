import os
from google.adk.agents import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model
from mcp_client.client import get_streamable_http_mcp_client

app = BedrockAgentCoreApp()
log = app.logger

APP_NAME = "{{ name }}"

# https://google.github.io/adk-docs/agents/models/
MODEL_ID = "gemini-2.5-flash"


# Define a simple function tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers"""
    return a + b


# Get MCP Toolset
mcp_toolset = [get_streamable_http_mcp_client()]

_credentials_loaded = False

def ensure_credentials_loaded():
    global _credentials_loaded
    if not _credentials_loaded:
        load_model()
        _credentials_loaded = True


# Agent Definition
agent = Agent(
    model=MODEL_ID,
    name="{{ name }}",
    description="Agent to answer questions",
    instruction="I can answer your questions using the knowledge I have!",
    tools=mcp_toolset + [add_numbers],
)


# Session and Runner
async def setup_session_and_runner(user_id, session_id):
    ensure_credentials_loaded()
    session_service = InMemorySessionService()
    session = await session_service.create_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id
    )
    runner = Runner(agent=agent, app_name=APP_NAME, session_service=session_service)
    return session, runner


# Agent Interaction
async def call_agent_async(query, user_id, session_id):
    content = types.Content(role="user", parts=[types.Part(text=query)])
    session, runner = await setup_session_and_runner(user_id, session_id)
    events = runner.run_async(
        user_id=user_id, session_id=session.id, new_message=content
    )

    final_response = None
    async for event in events:
        if event.is_final_response():
            final_response = event.content.parts[0].text

    return final_response


@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")

    # Process the user prompt
    prompt = payload.get("prompt", "What can you help me with?")
    session_id = getattr(context, "session_id", "default_session")
    user_id = payload.get("user_id", "default_user")

    # Run the agent
    result = await call_agent_async(prompt, user_id, session_id)

    # Return result
    return {"result": result}


if __name__ == "__main__":
    app.run()
