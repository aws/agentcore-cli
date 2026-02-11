# Local Development

The `dev` command runs your agent locally for testing before deployment.

## Starting the Dev Server

```bash
# Start dev server (auto-selects agent if only one)
agentcore dev

# Specify agent
agentcore dev --agent MyAgent

# Custom port
agentcore dev --port 3000

# Non-interactive mode (logs to stdout)
agentcore dev --logs
```

## Invoking Local Agents

With the dev server running, open another terminal:

```bash
# Interactive chat
agentcore invoke

# Single prompt
agentcore invoke "What can you do?"

# With streaming
agentcore invoke "Tell me a story" --stream

# Direct invoke to running server
agentcore dev --invoke "Hello" --stream
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

## Dev vs Deployed Behavior

| Aspect     | Local Dev     | Deployed                   |
| ---------- | ------------- | -------------------------- |
| API Keys   | `.env.local`  | AgentCore Identity service |
| Memory     | Not available | AgentCore Memory service   |
| Networking | localhost     | Public                     |

Memory requires deployment to test fully. For local testing, you can mock these dependencies in your agent code.
