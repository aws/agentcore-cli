FROM public.ecr.aws/docker/library/python:3.12-slim-trixie

RUN pip install --no-cache-dir uv

WORKDIR /app

ENV UV_SYSTEM_PYTHON=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_PROGRESS=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH"

RUN useradd -m -u 1000 bedrock_agentcore

# Install dependencies first so code changes don't invalidate the layer.
COPY pyproject.toml ./
RUN uv sync --no-dev --no-install-project

COPY --chown=bedrock_agentcore:bedrock_agentcore . .
RUN uv sync --no-dev

USER bedrock_agentcore

# AgentCore Runtime service contract port (HTTP mode).
# https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html
EXPOSE 8080

CMD ["python", "main.py"]
