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

| Flag                   | Description                                                              |
| ---------------------- | ------------------------------------------------------------------------ |
| `--name <name>`        | Project name (alphanumeric, max 23 chars)                                |
| `--defaults`           | Use defaults (Python, Strands, Bedrock, no memory)                       |
| `--no-agent`           | Skip agent creation                                                      |
| `--language <lang>`    | `Python` or `TypeScript`                                                 |
| `--framework <fw>`     | `Strands`, `LangChain_LangGraph`, `AutoGen`, `GoogleADK`, `OpenAIAgents` |
| `--model-provider <p>` | `Bedrock`, `Anthropic`, `OpenAI`, `Gemini`                               |
| `--api-key <key>`      | API key for non-Bedrock providers                                        |
| `--memory <opt>`       | `none`, `shortTerm`, `longAndShortTerm`                                  |
| `--output-dir <dir>`   | Output directory                                                         |
| `--skip-git`           | Skip git initialization                                                  |
| `--skip-python-setup`  | Skip venv setup                                                          |
| `--dry-run`            | Preview without creating                                                 |
| `--json`               | JSON output                                                              |

### deploy

Deploy infrastructure to AWS.

```bash
agentcore deploy
agentcore deploy --target production
agentcore deploy -y --progress        # Auto-confirm with progress
agentcore deploy -v --json            # Verbose JSON output
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
agentcore destroy
agentcore destroy --target dev -y     # Auto-confirm
```

| Flag              | Description       |
| ----------------- | ----------------- |
| `--target <name>` | Target to destroy |
| `-y, --yes`       | Skip confirmation |
| `--json`          | JSON output       |

### status

Check deployment status.

```bash
agentcore status
agentcore status --agent MyAgent
agentcore status --target production
```

| Flag                      | Description         |
| ------------------------- | ------------------- |
| `--agent <name>`          | Specific agent      |
| `--agent-runtime-id <id>` | Specific runtime ID |
| `--target <name>`         | Deployment target   |

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

Add a memory resource.

```bash
agentcore add memory \
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
agentcore add identity \
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

### add target

Add a deployment target.

```bash
agentcore add target \
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
agentcore add bind agent --source CallerAgent --target HelperAgent

# Memory
agentcore add bind memory --agent MyAgent --memory SharedMemory --access read

# Identity
agentcore add bind identity --agent MyAgent --identity OpenAI
```

### remove

Remove resources from project.

```bash
agentcore remove agent --name MyAgent --force
agentcore remove memory --name SharedMemory
agentcore remove identity --name OpenAI
agentcore remove target --name dev

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
agentcore invoke --agent MyAgent --target production
agentcore invoke --session-id abc123      # Continue session
agentcore invoke --new-session            # Fresh session
agentcore invoke --json                   # JSON output
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
agentcore package
agentcore package --agent MyAgent
agentcore package -d ./my-project
```

| Flag                     | Description            |
| ------------------------ | ---------------------- |
| `-d, --directory <path>` | Project directory      |
| `-a, --agent <name>`     | Package specific agent |

### outline

Display project resource tree.

```bash
agentcore outline
agentcore outline agent MyAgent
```

### update

Check for CLI updates.

```bash
agentcore update           # Check and install
agentcore update --check   # Check only
```

| Flag          | Description              |
| ------------- | ------------------------ |
| `-c, --check` | Check without installing |

---

## Common Patterns

### CI/CD Pipeline

```bash
# Validate and deploy with auto-confirm
agentcore validate
agentcore deploy --target production -y --json
```

### Scripted Project Setup

```bash
agentcore create --name MyProject --defaults
cd MyProject
agentcore add memory --name SharedMemory --strategies SEMANTIC --owner MyProject
agentcore add target --name dev --account 123456789012 --region us-west-2
agentcore deploy --target dev -y
```

### JSON Output for Automation

All commands with `--json` output structured data:

```bash
agentcore status --json | jq '.agents[0].runtimeArn'
agentcore invoke "Hello" --json | jq '.response'
```
