# Instructions for coding agents: runtime `{{name}}`

You are writing the code for an AgentCore runtime. The AgentCore CLI deploys
this folder. Follow these rules exactly, or `agentcore dev` and
`agentcore deploy` will fail. `README.md` in this folder explains each rule
in more detail.

## Must

- Put the entrypoint in `main.py` at the root of this folder. To use another
  file, name it in `pyproject.toml` under `[tool.agentcore]` as
  `entrypoint = "server.py"` (optionally `"server.py:app"`); the CLI copies it
  into `agentcore/agentcore.json` on `agentcore dev`, `build`, and `deploy`.
- Implement the runtime contract with the AgentCore SDK for Python
  (`bedrock-agentcore`, https://github.com/aws/bedrock-agentcore-sdk-python);
  examples: https://github.com/awslabs/amazon-bedrock-agentcore-samples.
{{#if (eq protocol "HTTP")}}
- Serve the AgentCore HTTP contract on `0.0.0.0` port 8080: `POST /invocations`
  (JSON in; JSON or `text/event-stream` out) and `GET /ping` (returns
  `{"status": "Healthy"}` or `{"status": "HealthyBusy"}`). Use
  `BedrockAgentCoreApp` from `bedrock_agentcore.runtime` with an
  `@app.entrypoint` function; it implements both.
- Keep a module-level `app` and end `main.py` with
  `if __name__ == "__main__": app.run()`.
{{/if}}
{{#if (eq protocol "MCP")}}
- Serve MCP over streamable HTTP on `0.0.0.0` port 8000 at `POST /mcp`, for
  example with `FastMCP("{{name}}", host="0.0.0.0", stateless_http=True)` and
  `mcp.run(transport="streamable-http")` under `if __name__ == "__main__":`.
- Accept the platform-provided `Mcp-Session-Id` header. Stay stateless unless
  the user needs elicitation or sampling with MCP protocol version 2025-11-25
  or earlier, which requires stateful mode.
- Add `mcp` to the dependencies. Pass
  `port=int(os.environ.get("FASTMCP_PORT", "8000"))` to `FastMCP`, so
  `agentcore dev` can move the server when port 8000 is busy.
{{/if}}
{{#if (eq protocol "A2A")}}
- Serve A2A on `0.0.0.0` port 9000: JSON-RPC 2.0 at `POST /` (for example
  `message/send`), the agent card at `GET /.well-known/agent-card.json`, and
  `GET /ping`. Use `serve_a2a(executor)` from `bedrock_agentcore.runtime`
  under `if __name__ == "__main__":`; it implements all three and reads the
  `A2A_PORT` override that `agentcore dev` sets for local development.
- Add `bedrock-agentcore[a2a] ~= 1.24.0` and `a2a-sdk` to the dependencies.
{{/if}}
{{#if (eq protocol "AGUI")}}
- Serve AG-UI on `0.0.0.0` port 8080: `POST /invocations` takes a
  `RunAgentInput` and streams AG-UI events as server-sent events, and
  `GET /ping` returns `{"status": "Healthy"}` or `{"status": "HealthyBusy"}`.
- Read the port from the `PORT` environment variable (default 8080) and start
  the server under `if __name__ == "__main__":`.
{{/if}}
- Declare every dependency in `[project].dependencies` in `pyproject.toml`.
  Do not use `requirements.txt`.
- Include `bedrock-agentcore` and `aws-opentelemetry-distro` in the
  dependencies.
- Set `requires-python` to a range that includes at least one of
  {{versions.python}}. It constrains `runtimeVersion` in `agentcore.json`:
  the CLI keeps the current version while the range allows it, and only
  replaces it (with the highest allowed) when the range excludes it.
- Only use packages that publish `aarch64` manylinux wheels (glibc ≤ 2.34).
- Read resource IDs from environment variables (`MEMORY_<NAME>_ID`,
  `AGENTCORE_GATEWAY_<NAME>_URL`, `CREDENTIAL_<NAME>_NAME`, ...) and handle
  them being missing.
- Use the `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header (or
  `context.session_id`) to tell conversations apart. Custom headers only
  arrive if they are named `X-Amzn-Bedrock-AgentCore-Runtime-Custom-*` and
  listed in `requestHeaderAllowlist`.

## Must not

- Do not hardcode secrets or put `.env` files in this folder. Use
  `agentcore add credential` and `@requires_api_key`.
- Do not edit `agentcore/agentcore.json` unless the user asks. Set the build
  settings in the code instead (`Dockerfile`, `requires-python`,
  `[tool.agentcore] entrypoint`); the CLI updates `agentcore.json` from them.
- Do not add a `Dockerfile` unless the user wants a container build.
  Adding one switches this runtime to container mode.
{{#if (or (eq protocol "HTTP") (eq protocol "A2A") (eq protocol "AGUI"))}}
- If you implement `/ping` yourself, do not set `time_of_last_update` to the
  current time on every ping; only change it when the status changes.
{{/if}}

## Check your work

- Run `uv sync`, then `agentcore dev`, and invoke it locally.
- Run `agentcore deploy` when the user is ready.
- Contract reference: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-{{contractPage}}-protocol-contract.html
