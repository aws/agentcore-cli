# CLI Commands Reference

All commands support non-interactive (scriptable) usage with flags. Use `--json` for machine-readable output.

## Project Lifecycle

### create

Create a new AgentCore project.

```bash
# Interactive wizard
agentcore-cli create

# Fully non-interactive with defaults
agentcore-cli create --name MyProject --defaults

# Custom configuration
agentcore-cli create \
  --name MyProject \
  --framework Strands \
  --model-provider Bedrock \
  --memory shortTerm \
  --output-dir ./projects

# Skip agent creation
agentcore-cli create --name MyProject --no-agent

# Preview without creating
agentcore-cli create --name MyProject --defaults --dry-run
```

| Flag                   | Description                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `--name <name>`        | Project name (alphanumeric, max 23 chars)                                          |
| `--defaults`           | Use defaults (Python, Strands, Bedrock, no memory)                                 |
| `--no-agent`           | Skip agent creation                                                                |
| `--language <lang>`    | `Python` or `TypeScript`                                                           |
| `--framework <fw>`     | `Strands`, `LangChain_LangGraph`, `AutoGen`, `CrewAI`, `GoogleADK`, `OpenAIAgents` |
| `--model-provider <p>` | `Bedrock`, `Anthropic`, `OpenAI`, `Gemini`                                         |
| `--api-key <key>`      | API key for non-Bedrock providers                                                  |
| `--memory <opt>`       | `none`, `shortTerm`, `longAndShortTerm`                                            |
| `--output-dir <dir>`   | Output directory                                                                   |
| `--skip-git`           | Skip git initialization                                                            |
| `--skip-python-setup`  | Skip venv setup                                                                    |
| `--dry-run`            | Preview without creating                                                           |
| `--json`               | JSON output                                                                        |

### deploy

Deploy infrastructure to AWS.

```bash
agentcore-cli deploy
agentcore-cli deploy --target production
agentcore-cli deploy -y --progress        # Auto-confirm with progress
agentcore-cli deploy -v --json            # Verbose JSON output
```

| Flag              | Description           |
| ----------------- | --------------------- |
| `--target <name>` | Deployment target     |
| `-y, --yes`       | Auto-confirm prompts  |
| `--progress`      | Real-time progress    |
| `-v, --verbose`   | Resource-level events |
| `--json`          | JSON output           |

### destroy

Tear down deployed resources.

```bash
agentcore-cli destroy
agentcore-cli destroy --target dev -y     # Auto-confirm
```

| Flag              | Description       |
| ----------------- | ----------------- |
| `--target <name>` | Target to destroy |
| `-y, --yes`       | Skip confirmation |
| `--json`          | JSON output       |

### status

Check deployment status.

```bash
agentcore-cli status
agentcore-cli status --agent MyAgent
agentcore-cli status --target production
```

| Flag                      | Description         |
| ------------------------- | ------------------- |
| `--agent <name>`          | Specific agent      |
| `--agent-runtime-id <id>` | Specific runtime ID |
| `--target <name>`         | Deployment target   |

### validate

Validate configuration files.

```bash
agentcore-cli validate
agentcore-cli validate -d ./my-project
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
agentcore-cli add agent \
  --name MyAgent \
  --framework Strands \
  --model-provider Bedrock \
  --memory shortTerm

# Bring your own code
agentcore-cli add agent \
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

Add a memory resource.

```bash
agentcore-cli add memory \
  --name SharedMemory \
  --strategies SEMANTIC,SUMMARIZATION \
  --expiry 30 \
  --owner MyAgent \
  --users AgentA,AgentB
```

| Flag                   | Description                                                               |
| ---------------------- | ------------------------------------------------------------------------- |
| `--name <name>`        | Memory name                                                               |
| `--description <desc>` | Description                                                               |
| `--strategies <types>` | Comma-separated: `SEMANTIC`, `SUMMARIZATION`, `USER_PREFERENCE`, `CUSTOM` |
| `--expiry <days>`      | Event expiry (default: 30)                                                |
| `--owner <agent>`      | Owning agent                                                              |
| `--users <agents>`     | Comma-separated users                                                     |
| `--json`               | JSON output                                                               |

### add identity

Add an identity provider (API key).

```bash
agentcore-cli add identity \
  --name OpenAI \
  --type ApiKeyCredentialProvider \
  --api-key sk-... \
  --owner MyAgent
```

| Flag               | Description                |
| ------------------ | -------------------------- |
| `--name <name>`    | Identity name              |
| `--type <type>`    | `ApiKeyCredentialProvider` |
| `--api-key <key>`  | API key value              |
| `--owner <agent>`  | Owning agent               |
| `--users <agents>` | Comma-separated users      |
| `--json`           | JSON output                |

### add mcp-tool

Add an MCP tool.

```bash
agentcore-cli add mcp-tool \
  --name MyTool \
  --language Python \
  --exposure mcp-runtime \
  --agents MyAgent
```

| Flag                   | Description              |
| ---------------------- | ------------------------ |
| `--name <name>`        | Tool name                |
| `--description <desc>` | Description              |
| `--language <lang>`    | `Python` or `TypeScript` |
| `--exposure <mode>`    | `mcp-runtime`            |
| `--agents <names>`     | Agents to attach         |
| `--json`               | JSON output              |

### add target

Add a deployment target.

```bash
agentcore-cli add target \
  --name production \
  --account 123456789012 \
  --region us-west-2 \
  --description "Production environment"
```

| Flag                   | Description    |
| ---------------------- | -------------- |
| `--name <name>`        | Target name    |
| `--account <id>`       | AWS account ID |
| `--region <region>`    | AWS region     |
| `--description <desc>` | Description    |
| `--json`               | JSON output    |

### add bind

Connect resources to agents.

```bash
# Agent-to-agent
agentcore-cli add bind agent --source CallerAgent --target HelperAgent

# Memory
agentcore-cli add bind memory --agent MyAgent --memory SharedMemory --access read

# Identity
agentcore-cli add bind identity --agent MyAgent --identity OpenAI

# MCP runtime
agentcore-cli add bind mcp-runtime --agent MyAgent --runtime MyTool
```

### remove

Remove resources from project.

```bash
agentcore-cli remove agent --name MyAgent --force
agentcore-cli remove memory --name SharedMemory
agentcore-cli remove mcp-tool --name MyTool
agentcore-cli remove identity --name OpenAI
agentcore-cli remove target --name dev

# Reset everything
agentcore-cli remove all --force
agentcore-cli remove all --dry-run  # Preview
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
agentcore-cli dev
agentcore-cli dev --agent MyAgent --port 3000
agentcore-cli dev --logs                      # Non-interactive
agentcore-cli dev --invoke "Hello" --stream   # Direct invoke
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
agentcore-cli invoke "What can you do?"
agentcore-cli invoke --prompt "Hello" --stream
agentcore-cli invoke --agent MyAgent --target production
agentcore-cli invoke --session-id abc123      # Continue session
agentcore-cli invoke --new-session            # Fresh session
agentcore-cli invoke --json                   # JSON output
```

| Flag                | Description               |
| ------------------- | ------------------------- |
| `--prompt <text>`   | Prompt text               |
| `--agent <name>`    | Specific agent            |
| `--target <name>`   | Deployment target         |
| `--session-id <id>` | Continue specific session |
| `--new-session`     | Start fresh session       |
| `--stream`          | Stream response           |
| `--json`            | JSON output               |

---

## Utilities

### package

Package agent artifacts without deploying.

```bash
agentcore-cli package
agentcore-cli package --agent MyAgent
agentcore-cli package -d ./my-project
```

| Flag                     | Description            |
| ------------------------ | ---------------------- |
| `-d, --directory <path>` | Project directory      |
| `-a, --agent <name>`     | Package specific agent |

### outline

Display project resource tree.

```bash
agentcore-cli outline
agentcore-cli outline agent MyAgent
```

### update

Check for CLI updates.

```bash
agentcore-cli update           # Check and install
agentcore-cli update --check   # Check only
```

| Flag          | Description              |
| ------------- | ------------------------ |
| `-c, --check` | Check without installing |

---

## Common Patterns

### CI/CD Pipeline

```bash
# Validate and deploy with auto-confirm
agentcore-cli validate
agentcore-cli deploy --target production -y --json
```

### Scripted Project Setup

```bash
agentcore-cli create --name MyProject --defaults
cd MyProject
agentcore-cli add memory --name SharedMemory --strategies SEMANTIC --owner MyProject
agentcore-cli add target --name dev --account 123456789012 --region us-west-2
agentcore-cli deploy --target dev -y
```

### JSON Output for Automation

All commands with `--json` output structured data:

```bash
agentcore-cli status --json | jq '.agents[0].runtimeArn'
agentcore-cli invoke "Hello" --json | jq '.response'
```
