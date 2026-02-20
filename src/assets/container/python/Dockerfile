FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

WORKDIR /app

ENV UV_SYSTEM_PYTHON=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_PROGRESS=1 \
    PYTHONUNBUFFERED=1 \
    DOCKER_CONTAINER=1

COPY pyproject.toml uv.lock* ./
RUN uv pip install -r pyproject.toml

RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore

COPY --chown=bedrock_agentcore:bedrock_agentcore . .

# 8080: AgentCore runtime endpoint
# 8000: Local dev server (uvicorn)
# 9000: OpenTelemetry collector
EXPOSE 8080 8000 9000

CMD ["opentelemetry-instrument", "python", "-m", "{{entrypoint}}"]
