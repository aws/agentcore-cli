import os

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from strands import Agent, tool
from ag_ui_strands import StrandsAgent, StrandsAgentConfig, add_ping, add_strands_fastapi_endpoint
from model.load import load_model
from memory.session import get_memory_session_manager


@tool
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers."""
    return a + b


agent = Agent(
    model=load_model(),
    system_prompt="You are a helpful assistant. Use tools when appropriate.",
    tools=[add_numbers],
)

# The AG-UI protocol carries a per-conversation thread_id; each thread gets its
# own session manager so history is scoped to the conversation. Returns None
# (in-process history only) until the deployed MEMORY_ID env var is set.
def session_manager_provider(input_data):
    return get_memory_session_manager(input_data.thread_id, "default-user")


config = StrandsAgentConfig(session_manager_provider=session_manager_provider)

agui_agent = StrandsAgent(
    agent=agent, name="{{ name }}", description="A helpful assistant", config=config
)

# The app is assembled here instead of with ag_ui_strands.create_strands_app so
# FastAPI's environment-driven OTLP export (FastAPI >= 0.142) can be turned off: the
# OpenTelemetry distro already exports traces and logs (SigV4-signed on the AgentCore
# Runtime), and a second FastAPI exporter would send every batch again, unsigned.
app = FastAPI(title="AWS Strands - {{ name }}", telemetry={"auto_configure": False})
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)
# The AG-UI endpoint at /invocations and a health check at /ping, matching the
# AgentCore Runtime HTTP service contract on 8080.
add_strands_fastapi_endpoint(app, agui_agent, "/invocations")
add_ping(app, "/ping")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
