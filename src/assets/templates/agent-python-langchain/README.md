# agent-python-langchain

A LangChain agent on AgentCore Runtime, calling Claude through Amazon Bedrock.
The agent is built with `create_agent`, keeps conversation history per Runtime
session, and streams its response.

## What's here

- `main.py`: the agent. A `BedrockAgentCoreApp` wraps an async entrypoint
  that reads `prompt` from the payload, runs the agent, and streams each model
  chunk back as a JSON event of content blocks. An `InMemorySaver` checkpointer
  keyed on the Runtime session id carries history between turns.
- `model/load.py`: creates the Bedrock chat model with `init_chat_model`.
- `pyproject.toml`: Python dependencies, managed with
  [uv](https://docs.astral.sh/uv/). `agentcore project create` has already run
  `uv sync` for you (unless you passed `--skip-install`), so `.venv/` is ready.

## Develop

Run the agent locally from the project root:

```bash
agentcore project dev
agentcore project invoke runtime --local --payload '{"prompt":"What is 2 plus 3?"}'
```

Environment variables for local development go in `agentcore/.env.local`
(gitignored).

## Deploy

```bash
agentcore project deploy
agentcore project invoke runtime --payload '{"prompt":"Hello!"}'
```

Traces are collected automatically: AgentCore Runtime starts the agent under
`opentelemetry-instrument`, which picks up `opentelemetry-instrumentation-langchain`
from the dependencies.

## Extending

Everything hangs off the `create_agent` call in `main.py`.

- **Tools.** Add a function decorated with `@tool` and append it to `tools`.
- **Middleware.** Hook the agent loop with `langchain.agents.middleware`, for
  example a `@before_model` function passed as `middleware=[...]`.
- **Durable memory.** Replace `InMemorySaver()` with `AgentCoreMemorySaver`
  from `langgraph-checkpoint-aws` and add `actor_id` next to `thread_id` in the
  `configurable` config to persist history in AgentCore Memory.
- **Structured output.** Pass a Pydantic model as `response_format=` and read
  `structured_response` from the final state.

See the [LangChain agents documentation](https://docs.langchain.com/oss/python/langchain/agents)
for the full `create_agent` surface.
