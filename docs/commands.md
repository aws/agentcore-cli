# CLI Commands Reference

All commands support non-interactive (scriptable) usage with flags. Use `--json` for machine-readable output.

## Project Lifecycle

### create

Create a new AgentCore project.

```bash
# Interactive wizard
agentcore create

# Fully non-interactive with defaults
agentcore create --name MyProject --defaults

# Custom configuration
agentcore create \
  --name MyProject \
  --framework Strands \
  --model-provider Bedrock \
  --memory shortTerm \
  --output-dir ./projects

# Skip agent creation
agentcore create --name MyProject --no-agent

# Preview without creating
agentcore create --name MyProject --defaults --dry-run
```

| Flag                   | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| `--name <name>`        | Project name (alphanumeric, max 23 chars)                     |
| `--defaults`           | Use defaults (Python, Strands, Bedrock, no memory)            |
| `--no-agent`           | Skip agent creation                                           |
| `--language <lang>`    | `Python` or `TypeScript`                                      |
| `--framework <fw>`     | `Strands`, `LangChain_LangGraph`, `GoogleADK`, `OpenAIAgents` |
| `--model-provider <p>` | `Bedrock`, `Anthropic`, `OpenAI`, `Gemini`                    |
| `--api-key <key>`      | API key for non-Bedrock providers                             |
| `--memory <opt>`       | `none`, `shortTerm`, `longAndShortTerm`                       |
| `--output-dir <dir>`   | Output directory                                              |
| `--skip-git`           | Skip git initialization                                       |
| `--skip-python-setup`  | Skip venv setup                                               |
| `--dry-run`            | Preview without creating                                      |
| `--json`               | JSON output                                                   |

### deploy

Deploy infrastructure to AWS.

```bash
agentcore deploy
agentcore deploy -y --progress        # Auto-confirm with progress
agentcore deploy -v --json            # Verbose JSON output
```

| Flag            | Description           |
| --------------- | --------------------- |
| `-y, --yes`     | Auto-confirm prompts  |
| `--progress`    | Real-time progress    |
| `-v, --verbose` | Resource-level events |
| `--json`        | JSON output           |

### status

Check deployment status.

```bash
agentcore status
agentcore status --agent MyAgent
```

| Flag                      | Description         |
| ------------------------- | ------------------- |
| `--agent <name>`          | Specific agent      |
| `--agent-runtime-id <id>` | Specific runtime ID |

### validate

Validate configuration files.

```bash
agentcore validate
agentcore validate -d ./my-project
```

| Flag                     | Description       |
| ------------------------ | ----------------- |
| `-d, --directory <path>` | Project directory |

---

## Resource Management

### add agent

Add an agent to the project.

```bash
# Create new agent from template
agentcore add agent \
  --name MyAgent \
  --framework Strands \
  --model-provider Bedrock \
  --memory shortTerm

# Bring your own code
agentcore add agent \
  --name MyAgent \
  --type byo \
  --code-location ./my-agent \
  --entrypoint main.py \
  --language Python \
  --framework Strands \
  --model-provider Bedrock
```

| Flag                     | Description                           |
| ------------------------ | ------------------------------------- |
| `--name <name>`          | Agent name                            |
| `--type <type>`          | `create` (default) or `byo`           |
| `--language <lang>`      | `Python`, `TypeScript`, `Other` (BYO) |
| `--framework <fw>`       | Agent framework                       |
| `--model-provider <p>`   | Model provider                        |
| `--api-key <key>`        | API key for non-Bedrock               |
| `--memory <opt>`         | Memory option (create only)           |
| `--code-location <path>` | Code path (BYO only)                  |
| `--entrypoint <file>`    | Entry file (BYO only)                 |
| `--json`                 | JSON output                           |

### add memory

Add a memory resource. Memory is a top-level resource in the flat resource model.

```bash
agentcore add memory \
  --name SharedMemory \
  --strategies SEMANTIC,SUMMARIZATION \
  --expiry 30
```

| Flag                   | Description                                                               |
| ---------------------- | ------------------------------------------------------------------------- |
| `--name <name>`        | Memory name                                                               |
| `--description <desc>` | Description                                                               |
| `--strategies <types>` | Comma-separated: `SEMANTIC`, `SUMMARIZATION`, `USER_PREFERENCE`, `CUSTOM` |
| `--expiry <days>`      | Event expiry (default: 30)                                                |
| `--json`               | JSON output                                                               |

### add identity

Add a credential provider (API key). Credentials are top-level resources in the flat resource model.

```bash
agentcore add identity \
  --name OpenAI \
  --api-key sk-...
```

| Flag              | Description     |
| ----------------- | --------------- |
| `--name <name>`   | Credential name |
| `--api-key <key>` | API key value   |
| `--json`          | JSON output     |

### remove

Remove resources from project.

```bash
agentcore remove agent --name MyAgent --force
agentcore remove memory --name SharedMemory
agentcore remove identity --name OpenAI

# Reset everything
agentcore remove all --force
agentcore remove all --dry-run  # Preview
```

| Flag            | Description               |
| --------------- | ------------------------- |
| `--name <name>` | Resource name             |
| `--force`       | Skip confirmation         |
| `--dry-run`     | Preview (remove all only) |
| `--json`        | JSON output               |

---

## Development

### dev

Start local development server.

```bash
agentcore dev
agentcore dev --agent MyAgent --port 3000
agentcore dev --logs                      # Non-interactive
agentcore dev --invoke "Hello" --stream   # Direct invoke
```

| Flag                    | Description                     |
| ----------------------- | ------------------------------- |
| `-p, --port <port>`     | Port (default: 8080)            |
| `-a, --agent <name>`    | Agent to run                    |
| `-i, --invoke <prompt>` | Invoke running server           |
| `-s, --stream`          | Stream response (with --invoke) |
| `-l, --logs`            | Non-interactive stdout logging  |

### invoke

Invoke local or deployed agents.

```bash
agentcore invoke "What can you do?"
agentcore invoke --prompt "Hello" --stream
agentcore invoke --agent MyAgent
agentcore invoke --session-id abc123      # Continue session
agentcore invoke --new-session            # Fresh session
agentcore invoke --json                   # JSON output
```

| Flag                | Description               |
| ------------------- | ------------------------- |
| `--prompt <text>`   | Prompt text               |
| `--agent <name>`    | Specific agent            |
| `--session-id <id>` | Continue specific session |
| `--new-session`     | Start fresh session       |
| `--stream`          | Stream response           |
| `--json`            | JSON output               |

---

## Utilities

### package

Package agent artifacts without deploying.

```bash
agentcore package
agentcore package --agent MyAgent
agentcore package -d ./my-project
```

| Flag                     | Description            |
| ------------------------ | ---------------------- |
| `-d, --directory <path>` | Project directory      |
| `-a, --agent <name>`     | Package specific agent |

### update

Check for CLI updates.

```bash
agentcore update           # Check and install
```

---

## Common Patterns

### CI/CD Pipeline

```bash
# Validate and deploy with auto-confirm
agentcore validate
agentcore deploy -y --json
```

### Scripted Project Setup

```bash
agentcore create --name MyProject --defaults
cd MyProject
agentcore add memory --name SharedMemory --strategies SEMANTIC
agentcore deploy -y
```

### JSON Output for Automation

All commands with `--json` output structured data:

```bash
agentcore status --json | jq '.agents[0].runtimeArn'
agentcore invoke "Hello" --json | jq '.response'
```
