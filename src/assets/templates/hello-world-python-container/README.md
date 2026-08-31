# hello-world

An AgentCore Runtime agent built with the [Strands](https://strandsagents.com)
SDK. Scaffolded by `agentcore project create`.

## Layout

- `main.py` — the agent: a `BedrockAgentCoreApp` entrypoint that streams
  responses from a Strands `Agent`.
- `pyproject.toml` — dependencies, installed with [uv](https://docs.astral.sh/uv/).

## Develop

Run the agent locally from the project root:

```bash
agentcore project dev
```

Environment variables for local development go in `agentcore/.env.local`
(gitignored).

## Deploy

```bash
agentcore project deploy
```

Invoke the deployed Runtime with its native payload:

```bash
agentcore project invoke runtime --payload '{"prompt":"Hello!"}'
```
