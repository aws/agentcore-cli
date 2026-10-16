# Instructions for coding agents: runtime `{{name}}`

You are writing the code for an AgentCore runtime. The AgentCore CLI deploys
this folder. Follow these rules exactly, or `agentcore dev` and
`agentcore deploy` will fail. `README.md` in this folder explains each rule
in more detail.

## Must

- Put the entrypoint in `main.ts` at the root of this folder. The CLI bundles
  it into `main.js`, which `agentcore.json` records as the entrypoint. A
  `"main"` in `package.json` other than `"main.ts"` is ignored.
- Implement the runtime contract with the AgentCore SDK for TypeScript
  (`bedrock-agentcore`, https://github.com/aws/bedrock-agentcore-sdk-typescript);
  examples: https://github.com/awslabs/amazon-bedrock-agentcore-samples.
{{#if (eq protocol "HTTP")}}
- Serve the AgentCore HTTP contract on `0.0.0.0` port 8080: `POST /invocations`
  (JSON in; JSON or `text/event-stream` out) and `GET /ping` (returns
  `{"status": "Healthy"}` or `{"status": "HealthyBusy"}`). Use
  `BedrockAgentCoreApp` from `bedrock-agentcore/runtime`; it implements both.
- Start the server with `app.run({ port: parseInt(process.env.PORT ?? '8080') })`.
{{/if}}
{{#if (eq protocol "MCP")}}
- Serve MCP over streamable HTTP on `0.0.0.0` port 8000 at `POST /mcp`.
- Accept the platform-provided `Mcp-Session-Id` header. Stay stateless unless
  the user needs elicitation or sampling with MCP protocol version 2025-11-25
  or earlier, which requires stateful mode.
- Read the port from the `PORT` environment variable (default 8000).
{{/if}}
{{#if (eq protocol "A2A")}}
- Serve A2A on `0.0.0.0` port 9000: JSON-RPC 2.0 at `POST /` (for example
  `message/send`), the agent card at `GET /.well-known/agent-card.json`, and
  `GET /ping` returning `{"status": "Healthy"}`.
- Read the port from the `PORT` environment variable (default 9000).
{{/if}}
{{#if (eq protocol "AGUI")}}
- Serve AG-UI on `0.0.0.0` port 8080: `POST /invocations` takes a
  `RunAgentInput` and streams AG-UI events as server-sent events, and
  `GET /ping` returns `{"status": "Healthy"}` or `{"status": "HealthyBusy"}`.
- Read the port from the `PORT` environment variable (default 8080).
{{/if}}
- Declare every dependency in `package.json`, including `bedrock-agentcore`
  and `tsx` (used by `agentcore dev`).
- Set `engines.node` to a range that includes at least one of
  {{versions.node}}. It constrains `runtimeVersion` in `agentcore.json`: the
  CLI keeps the current version while the range allows it, and only replaces
  it (with the highest allowed) when the range excludes it.
- Run `npm install` so `node_modules` exists; deploy bundles from it.
- Read resource IDs from environment variables (`MEMORY_<NAME>_ID`,
  `AGENTCORE_GATEWAY_<NAME>_URL`, `CREDENTIAL_<NAME>_NAME`, ...) and handle
  them being missing.
- Use the `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` header to tell
  conversations apart. Custom headers only arrive if they are named
  `X-Amzn-Bedrock-AgentCore-Runtime-Custom-*` and listed in
  `requestHeaderAllowlist`.

## Must not

- Do not use top-level `await` in `main.ts` or anything it imports; the
  bundle is CommonJS.
- Do not hardcode secrets or put `.env` files in this folder. Use
  `agentcore add credential` and `withApiKey`.
- Do not edit `agentcore/agentcore.json` unless the user asks. Set the build
  settings in the code instead (`Dockerfile`, `engines.node`); the CLI updates
  `agentcore.json` from them.
- Do not add a `Dockerfile` unless the user wants a container build.
  Adding one switches this runtime to container mode.
{{#if (or (eq protocol "HTTP") (eq protocol "A2A") (eq protocol "AGUI"))}}
- If you implement `/ping` yourself, do not set `time_of_last_update` to the
  current time on every ping; only change it when the status changes.
{{/if}}

## Check your work

- Run `npm install`, then `agentcore dev`, and invoke it locally.
- Run `agentcore deploy` when the user is ready.
- Contract reference: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-{{contractPage}}-protocol-contract.html
