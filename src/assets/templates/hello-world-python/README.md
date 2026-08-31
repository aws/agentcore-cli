# hello-world

A minimal AgentCore Runtime agent built with the
[Strands Agents SDK](https://strandsagents.com) — our recommended framework
for building agents on AWS Bedrock AgentCore.

## What's here

- `main.py` — the agent. A `BedrockAgentCoreApp` wraps a Strands `Agent`;
  the `@app.entrypoint` function receives each invocation payload and streams
  the agent's response back to the caller.
- `pyproject.toml` — Python dependencies, managed with
  [uv](https://docs.astral.sh/uv/). `agentcore project create` has already run
  `uv sync` for you (unless you passed `--skip-install`), so `.venv/` is ready.

## Run it locally

```bash
uv run main.py
```

The app listens on http://localhost:8080. Invoke it:

```bash
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello!"}'
```

## Build your agent

Start in `main.py`:

- Change the `system_prompt` to shape your agent's behavior.
- Give it tools — Strands ships ready-made ones and makes custom tools a
  decorator away:

  ```python
  from strands import Agent, tool

  @tool
  def word_count(text: str) -> int:
      """Count words in text."""
      return len(text.split())

  agent = Agent(system_prompt="You are a helpful assistant.", tools=[word_count])
  ```

- Add dependencies with `uv add <package>`.

See the [Strands documentation](https://strandsagents.com/latest/documentation/docs/)
for multi-agent patterns, MCP tools, and model configuration.

## Deploy

Deploy from the project root with the AgentCore CLI; the CDK app under
`agentcore/cdk` provisions the Runtime that hosts this agent.

```bash
agentcore project deploy
agentcore project invoke runtime --payload '{"prompt":"Hello!"}'
```
