# agent-python-minimal

A minimal AgentCore Runtime HTTP agent with no agent framework. Its
`@app.entrypoint` returns a fixed `Hello, world!` message for every
invocation — a starting point you own and grow into a real agent.

## What's here

- `main.py` — the agent. A `BedrockAgentCoreApp` wraps the entrypoint that
  receives each invocation payload and returns the response.
- `pyproject.toml` — Python dependencies, managed with
  [uv](https://docs.astral.sh/uv/). `agentcore create` has already run
  `uv sync` for you (unless you passed `--skip-install`), so `.venv/` is ready.

## Develop

Run the agent locally from the project root:

```bash
agentcore dev
```

Environment variables for local development go in `agentcore/.env.local`
(gitignored).

## Deploy

```bash
agentcore deploy
agentcore invoke --runtime {{name}} --payload '{"prompt":"Hello!"}'
```
