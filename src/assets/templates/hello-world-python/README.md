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

```bash
agentcore project deploy
```
