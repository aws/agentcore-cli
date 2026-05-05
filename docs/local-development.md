# Local Development

The `dev` command runs your agent locally for testing before deployment.

## Starting the Dev Server

```bash
# Start dev server (auto-selects agent if only one)
agentcore dev

# Specify agent
agentcore dev --runtime MyAgent

# Custom port
agentcore dev --port 3000

# Non-interactive mode (logs to stdout)
agentcore dev --logs
```

## Invoking Local Agents

Start the dev server in one terminal, then send prompts from another:

```bash
# Terminal 1: start the dev server
agentcore dev --logs

# Terminal 2: send prompts
agentcore dev "What can you do?"
agentcore dev "Tell me a story" --stream
agentcore dev "Hello" --runtime MyAgent
```

## Environment Setup

### Python Virtual Environment

The dev server automatically:

1. Creates `.venv` if it doesn't exist
2. Runs `uv sync` to install dependencies from `pyproject.toml`
3. Starts uvicorn with your agent

### API Keys

For non-Bedrock providers, add keys to `agentcore/.env.local`:

```bash
AGENTCORE_CREDENTIAL_{projectName}OPENAI=sk-...
AGENTCORE_CREDENTIAL_{projectName}ANTHROPIC=sk-ant-...
AGENTCORE_CREDENTIAL_{projectName}GEMINI=...
```

## Debugging

### Log Files

Logs are written to `agentcore/.cli/logs/`:

```
agentcore/.cli/logs/
├── dev/           # Dev server logs
└── invoke/        # Invocation logs with request/response
```

### Verbose Output

```bash
# Dev server with stdout logging
agentcore dev --logs
```

### Common Issues

**Port already in use:**

```bash
agentcore dev --port 8081
```

**Missing dependencies:**

```bash
cd app/MyAgent
uv sync
```

## Hot Reload

The dev server watches for file changes and automatically reloads. Edit your agent code and the changes take effect
immediately.

### Container Agents

For container agents, the dev server builds a Docker image and runs it with your source directory mounted as a volume.
Changes to your code are picked up by uvicorn's `--reload` inside the container — no image rebuild needed.

See [Container Builds](container-builds.md) for full details on container development.

## Dev vs Deployed Behavior

| Aspect     | Local Dev                    | Deployed                   |
| ---------- | ---------------------------- | -------------------------- |
| API Keys   | `.env.local`                 | AgentCore Identity service |
| Memory     | Not available                | AgentCore Memory service   |
| Gateways   | Env vars from deployed state | CDK-injected env vars      |
| Networking | localhost                    | Public                     |

Memory requires deployment to test fully. For local testing, you can mock these dependencies in your agent code.

## Telemetry

In dev mode the CLI automatically starts a local OTLP/HTTP collector and injects the standard OpenTelemetry environment
variables into the agent process. Traces are persisted to `agentcore/.cli/traces/` and displayed in the web UI.

### Custom OTLP Endpoint

To forward traces to your own backend (Jaeger, Grafana Tempo, a cloud collector, etc.) instead of the local collector:

```bash
agentcore dev --otel-endpoint http://localhost:4318
```

When `--otel-endpoint` is set:

- The local in-process collector is **not** started — no port is bound by the CLI
- `OTEL_EXPORTER_OTLP_ENDPOINT` is set to your URL
- All other OTEL env vars are injected as normal
- Traces will **not** appear in the web UI traces panel (they go directly to your backend)

The endpoint at startup is printed to stdout:

```
OTEL traces → http://localhost:4318
```

### Disabling Traces

To disable telemetry collection entirely:

```bash
agentcore dev --no-traces
```

No OTEL env vars are injected into the agent process. `--no-traces` and `--otel-endpoint` are mutually exclusive — passing both is an error.

### Trace Storage

When using the default local collector, traces are persisted as OTLP JSON Lines files:

```
agentcore/.cli/traces/otlp/
└── <agent-name>-<traceId>.otlp.jsonl
```

Traces survive dev server restarts and are available in the web UI traces panel across sessions.

## Gateway Environment Variables

When you have deployed gateways, `agentcore dev` automatically injects gateway environment variables into your local
agent process. This lets your local agent connect to real deployed gateways during development.

The dev server reads `deployed-state.json` and `agentcore.json` to generate:

```bash
AGENTCORE_GATEWAY_{NAME}_URL=https://{gateway-id}.gateway.agentcore.{region}.amazonaws.com
AGENTCORE_GATEWAY_{NAME}_AUTH_TYPE=NONE|AWS_IAM|CUSTOM_JWT
```

The gateway name is uppercased with hyphens replaced by underscores. For example, a gateway named `my-gateway` produces:

```bash
AGENTCORE_GATEWAY_MY_GATEWAY_URL=https://...
AGENTCORE_GATEWAY_MY_GATEWAY_AUTH_TYPE=NONE
```

### Requirements

Gateway env vars require a prior deployment — the dev server reads the gateway URLs from `deployed-state.json`, which is
populated by `agentcore deploy`. If you haven't deployed yet, no gateway env vars will be set.

### Workflow

```bash
# 1. Add a gateway and target
agentcore add gateway --name my-gateway
agentcore add gateway-target --name my-tools --type mcp-server \
  --endpoint https://mcp.example.com/mcp --gateway my-gateway

# 2. Deploy to create the gateway
agentcore deploy -y

# 3. Run locally — gateway env vars are injected automatically
agentcore dev
```

Your agent code reads these env vars to connect to the gateway. The agent templates generated by the CLI already include
this wiring.
