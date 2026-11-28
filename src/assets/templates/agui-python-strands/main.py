import os
from contextvars import ContextVar

import uvicorn
from fastapi import FastAPI, Request
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

# The AgentCore Runtime session of the request, from its
# X-Amzn-Bedrock-AgentCore-Runtime-Session-Id header (see the middleware below).
_runtime_session_id: ContextVar[str | None] = ContextVar("runtime_session_id", default=None)


# Each AG-UI thread gets its own session manager. Memory keeps the conversation
# under the AgentCore Runtime session, as an HTTP agent does: a runtime in a box
# may read and write only the Memory events of its own session. With no runtime
# session, as in a local run, it uses the AG-UI thread_id. Returns None
# (in-process history only) until the deployed MEMORY_ID env var is set.
def session_manager_provider(input_data):
    session_id = _runtime_session_id.get() or input_data.thread_id
    return get_memory_session_manager(session_id, "default-user")


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


@app.middleware("http")
async def read_runtime_session(request: Request, call_next):
    _runtime_session_id.set(request.headers.get("x-amzn-bedrock-agentcore-runtime-session-id"))
    return await call_next(request)

# The AG-UI endpoint at /invocations and a health check at /ping, matching the
# AgentCore Runtime HTTP service contract on 8080.
add_strands_fastapi_endpoint(app, agui_agent, "/invocations")
add_ping(app, "/ping")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
