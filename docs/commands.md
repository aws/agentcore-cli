# CLI Commands Reference

All commands support non-interactive (scriptable) usage with flags. Use `--json` for machine-readable output.

Run `agentcore` without arguments to launch the interactive TUI. Flags marked `[non-interactive]` trigger CLI mode — run
`agentcore help modes` for details.

## Command Aliases

| Command   | Alias |
| --------- | ----- |
| `deploy`  | `p`   |
| `dev`     | `d`   |
| `invoke`  | `i`   |
| `status`  | `s`   |
| `logs`    | `l`   |
| `traces`  | `t`   |
| `package` | `pkg` |

---

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

# With networking
agentcore create \
  --name MyProject \
  --defaults \
  --network-mode VPC \
  --subnets subnet-abc,subnet-def \
  --security-groups sg-123

# Skip agent creation
agentcore create --name MyProject --no-agent

# Preview without creating
agentcore create --name MyProject --defaults --dry-run

# Import from Bedrock Agents
agentcore create \
  --name MyImportedAgent \
  --type import \
  --agent-id AGENT123 \
  --agent-alias-id ALIAS456 \
  --region us-east-1 \
  --framework Strands \
  --memory none
```

| Flag                      | Description                                                                      |
| ------------------------- | -------------------------------------------------------------------------------- |
| `--name <name>`           | Project name (alphanumeric, starts with letter, max 23 chars)                    |
| `--defaults`              | Use defaults (Python, Strands, Bedrock, no memory)                               |
| `--no-agent`              | Skip agent creation                                                              |
| `--type <type>`           | `create` (default) or `import`                                                   |
| `--language <lang>`       | `Python` (default)                                                               |
| `--framework <fw>`        | `Strands`, `LangChain_LangGraph`, `CrewAI`, `GoogleADK`, `OpenAIAgents`          |
| `--model-provider <p>`    | `Bedrock`, `Anthropic`, `OpenAI`, `Gemini`                                       |
| `--build <type>`          | `CodeZip` (default) or `Container` (see [Container Builds](container-builds.md)) |
| `--api-key <key>`         | API key for non-Bedrock providers                                                |
| `--memory <opt>`          | `none`, `shortTerm`, `longAndShortTerm`                                          |
| `--protocol <protocol>`   | `HTTP` (default), `MCP`, `A2A`                                                   |
| `--network-mode <mode>`   | `PUBLIC` (default) or `VPC`                                                      |
| `--subnets <ids>`         | Comma-separated subnet IDs (required for VPC mode)                               |
| `--security-groups <ids>` | Comma-separated security group IDs (required for VPC mode)                       |
| `--agent-id <id>`         | Bedrock Agent ID (import only)                                                   |
| `--agent-alias-id <id>`   | Bedrock Agent Alias ID (import only)                                             |
| `--region <region>`       | AWS region for Bedrock Agent (import only)                                       |
| `--output-dir <dir>`      | Output directory                                                                 |
| `--skip-git`              | Skip git initialization                                                          |
| `--skip-python-setup`     | Skip venv setup                                                                  |
| `--dry-run`               | Preview without creating                                                         |
| `--json`                  | JSON output                                                                      |

### deploy

Deploy infrastructure to AWS.

```bash
agentcore deploy
agentcore deploy -y                  # Auto-confirm
agentcore deploy -y -v               # Auto-confirm with verbose output
agentcore deploy --plan              # Preview without deploying (dry-run)
agentcore deploy --diff              # Show CDK diff without deploying
agentcore deploy --target staging -y # Deploy to a specific target
agentcore deploy -y --json           # JSON output
```

| Flag              | Description                                   |
| ----------------- | --------------------------------------------- |
| `--target <name>` | Deployment target name (default: `"default"`) |
| `-y, --yes`       | Auto-confirm prompts                          |
| `-v, --verbose`   | Resource-level deployment events              |
| `--plan`          | Preview deployment without deploying          |
| `--diff`          | Show CDK diff without deploying               |
| `--json`          | JSON output                                   |

### status

Check deployment status and resource details.

```bash
agentcore status
agentcore status --agent MyAgent
agentcore status --type evaluator
agentcore status --state deployed
agentcore status --agent-runtime-id abc123
agentcore status --json
```

| Flag                      | Description                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| `--agent-runtime-id <id>` | Look up a specific agent runtime by ID                                                          |
| `--target <name>`         | Select deployment target                                                                        |
| `--type <type>`           | Filter by resource type: `agent`, `memory`, `credential`, `gateway`, `evaluator`, `online-eval` |
| `--state <state>`         | Filter by deployment state: `deployed`, `local-only`, `pending-removal`                         |
| `--agent <name>`          | Filter to a specific agent                                                                      |
| `--json`                  | JSON output                                                                                     |

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
  --language Python

# With MCP protocol and VPC networking
agentcore add agent \
  --name MyAgent \
  --framework Strands \
  --model-provider Bedrock \
  --protocol MCP \
  --network-mode VPC \
  --subnets subnet-abc,subnet-def \
  --security-groups sg-123

# Import from Bedrock Agents
agentcore add agent \
  --name MyAgent \
  --type import \
  --agent-id AGENT123 \
  --agent-alias-id ALIAS456 \
  --region us-east-1 \
  --framework Strands \
  --memory none
```

| Flag                      | Description                                                                      |
| ------------------------- | -------------------------------------------------------------------------------- |
| `--name <name>`           | Agent name (alphanumeric, starts with letter, max 64 chars)                      |
| `--type <type>`           | `create` (default), `byo`, or `import`                                           |
| `--build <type>`          | `CodeZip` (default) or `Container` (see [Container Builds](container-builds.md)) |
| `--language <lang>`       | `Python` (create); `Python`, `TypeScript`, `Other` (BYO)                         |
| `--framework <fw>`        | `Strands`, `LangChain_LangGraph`, `CrewAI`, `GoogleADK`, `OpenAIAgents`          |
| `--model-provider <p>`    | `Bedrock`, `Anthropic`, `OpenAI`, `Gemini`                                       |
| `--api-key <key>`         | API key for non-Bedrock providers                                                |
| `--memory <opt>`          | `none`, `shortTerm`, `longAndShortTerm` (create and import)                      |
| `--protocol <protocol>`   | `HTTP` (default), `MCP`, `A2A`                                                   |
| `--code-location <path>`  | Path to existing code (BYO only)                                                 |
| `--entrypoint <file>`     | Entry file relative to code-location (BYO, default: `main.py`)                   |
| `--network-mode <mode>`   | `PUBLIC` (default) or `VPC`                                                      |
| `--subnets <ids>`         | Comma-separated subnet IDs (required for VPC mode)                               |
| `--security-groups <ids>` | Comma-separated security group IDs (required for VPC mode)                       |
| `--agent-id <id>`         | Bedrock Agent ID (import only)                                                   |
| `--agent-alias-id <id>`   | Bedrock Agent Alias ID (import only)                                             |
| `--region <region>`       | AWS region for Bedrock Agent (import only)                                       |
| `--json`                  | JSON output                                                                      |

### add memory

Add a memory resource.

```bash
agentcore add memory \
  --name SharedMemory \
  --strategies SEMANTIC,SUMMARIZATION \
  --expiry 30
```

| Flag                   | Description                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `--name <name>`        | Memory name                                                     |
| `--strategies <types>` | Comma-separated: `SEMANTIC`, `SUMMARIZATION`, `USER_PREFERENCE` |
| `--expiry <days>`      | Event expiry duration in days (default: 30, min: 7, max: 365)   |
| `--json`               | JSON output                                                     |

### add gateway

Add a gateway to the project. Gateways act as MCP-compatible proxies that route agent requests to backend tools.

```bash
# Interactive mode (select 'Gateway' from the menu)
agentcore add

# No authorization (development/testing)
agentcore add gateway --name MyGateway

# CUSTOM_JWT authorization (production)
agentcore add gateway \
  --name MyGateway \
  --authorizer-type CUSTOM_JWT \
  --discovery-url https://idp.example.com/.well-known/openid-configuration \
  --allowed-audience my-api \
  --allowed-clients my-client-id \
  --agent-client-id agent-client-id \
  --agent-client-secret agent-client-secret
```

| Flag                             | Description                                                  |
| -------------------------------- | ------------------------------------------------------------ |
| `--name <name>`                  | Gateway name                                                 |
| `--description <desc>`           | Gateway description                                          |
| `--authorizer-type <type>`       | `NONE` (default) or `CUSTOM_JWT`                             |
| `--discovery-url <url>`          | OIDC discovery URL (required for CUSTOM_JWT)                 |
| `--allowed-audience <values>`    | Comma-separated allowed audiences (required for CUSTOM_JWT)  |
| `--allowed-clients <values>`     | Comma-separated allowed client IDs (required for CUSTOM_JWT) |
| `--allowed-scopes <scopes>`      | Comma-separated allowed scopes (optional for CUSTOM_JWT)     |
| `--agent-client-id <id>`         | Agent OAuth client ID for Bearer token auth (CUSTOM_JWT)     |
| `--agent-client-secret <secret>` | Agent OAuth client secret (CUSTOM_JWT)                       |
| `--agents <agents>`              | Comma-separated agent names                                  |
| `--no-semantic-search`           | Disable semantic search for tool discovery                   |
| `--exception-level <level>`      | Exception verbosity level (default: `NONE`)                  |
| `--json`                         | JSON output                                                  |

### add gateway-target

Add a gateway target to the project. Targets are backend tools exposed through a gateway. Supports five target types:
`mcp-server`, `api-gateway`, `open-api-schema`, `smithy-model`, and `lambda-function-arn`.

```bash
# Interactive mode (select 'Gateway Target' from the menu)
agentcore add

# MCP Server endpoint
agentcore add gateway-target \
  --name WeatherTools \
  --type mcp-server \
  --endpoint https://mcp.example.com/mcp \
  --gateway MyGateway

# MCP Server with OAuth outbound auth
agentcore add gateway-target \
  --name SecureTools \
  --type mcp-server \
  --endpoint https://api.example.com/mcp \
  --gateway MyGateway \
  --outbound-auth oauth \
  --oauth-client-id my-client \
  --oauth-client-secret my-secret \
  --oauth-discovery-url https://auth.example.com/.well-known/openid-configuration

# API Gateway REST API
agentcore add gateway-target \
  --name PetStore \
  --type api-gateway \
  --rest-api-id abc123 \
  --stage prod \
  --tool-filter-path '/pets/*' \
  --tool-filter-methods GET,POST \
  --gateway MyGateway

# OpenAPI Schema (auto-derive tools from spec)
agentcore add gateway-target \
  --name PetStoreAPI \
  --type open-api-schema \
  --schema specs/petstore.json \
  --gateway MyGateway \
  --outbound-auth oauth \
  --credential-name MyOAuth

# Smithy Model (auto-derive tools from model)
agentcore add gateway-target \
  --name MyService \
  --type smithy-model \
  --schema models/service.json \
  --gateway MyGateway

# Lambda Function ARN
agentcore add gateway-target \
  --name MyLambdaTools \
  --type lambda-function-arn \
  --lambda-arn arn:aws:lambda:us-east-1:123456789012:function:my-func \
  --tool-schema-file tools.json \
  --gateway MyGateway
```

| Flag                               | Description                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--name <name>`                    | Target name                                                                                                   |
| `--description <desc>`             | Target description                                                                                            |
| `--type <type>`                    | Target type (required): `mcp-server`, `api-gateway`, `open-api-schema`, `smithy-model`, `lambda-function-arn` |
| `--endpoint <url>`                 | MCP server endpoint URL (mcp-server)                                                                          |
| `--language <lang>`                | Implementation language: Python, TypeScript, Other (mcp-server)                                               |
| `--host <host>`                    | Compute host: Lambda or AgentCoreRuntime (mcp-server)                                                         |
| `--gateway <name>`                 | Gateway to attach target to                                                                                   |
| `--outbound-auth <type>`           | `oauth`, `api-key`, or `none` (varies by target type)                                                         |
| `--credential-name <name>`         | Existing credential name for outbound auth                                                                    |
| `--oauth-client-id <id>`           | OAuth client ID (creates credential inline)                                                                   |
| `--oauth-client-secret <secret>`   | OAuth client secret (creates credential inline)                                                               |
| `--oauth-discovery-url <url>`      | OAuth discovery URL (creates credential inline)                                                               |
| `--oauth-scopes <scopes>`          | OAuth scopes, comma-separated                                                                                 |
| `--rest-api-id <id>`               | API Gateway REST API ID (api-gateway)                                                                         |
| `--stage <stage>`                  | API Gateway stage name (api-gateway)                                                                          |
| `--tool-filter-path <path>`        | Filter API paths, supports wildcards (api-gateway)                                                            |
| `--tool-filter-methods <methods>`  | Comma-separated HTTP methods to expose (api-gateway)                                                          |
| `--tool-filter-description <desc>` | Tool filter description pattern                                                                               |
| `--schema <path>`                  | Path to schema file, relative to project root (open-api-schema, smithy-model)                                 |
| `--schema-s3-account <account>`    | AWS account for S3-hosted schema (open-api-schema, smithy-model)                                              |
| `--lambda-arn <arn>`               | Lambda function ARN (lambda-function-arn)                                                                     |
| `--tool-schema-file <path>`        | Tool schema file, relative to project root or absolute path (lambda-function-arn)                             |
| `--json`                           | JSON output                                                                                                   |

> **Note**: `smithy-model` and `lambda-function-arn` use IAM role auth and do not support `--outbound-auth`.
> `open-api-schema` requires `--outbound-auth` (`oauth` or `api-key`). `api-gateway` supports `api-key` or `none`.
> `mcp-server` supports `oauth` or `none`.

### add identity

Add a credential to the project. Supports API key and OAuth credential types.

```bash
# API key credential
agentcore add identity \
  --name OpenAI \
  --api-key sk-...

# OAuth credential
agentcore add identity \
  --name MyOAuthProvider \
  --type oauth \
  --discovery-url https://idp.example.com/.well-known/openid-configuration \
  --client-id my-client-id \
  --client-secret my-client-secret \
  --scopes read,write
```

| Flag                       | Description                      |
| -------------------------- | -------------------------------- |
| `--name <name>`            | Credential name                  |
| `--type <type>`            | `api-key` (default) or `oauth`   |
| `--api-key <key>`          | API key value (api-key type)     |
| `--discovery-url <url>`    | OAuth discovery URL (oauth type) |
| `--client-id <id>`         | OAuth client ID (oauth type)     |
| `--client-secret <secret>` | OAuth client secret (oauth type) |
| `--scopes <scopes>`        | OAuth scopes, comma-separated    |
| `--json`                   | JSON output                      |

### add evaluator

Add a custom LLM-as-a-Judge evaluator. See [Evaluations](evals.md) for full details.

```bash
agentcore add evaluator \
  --name ResponseQuality \
  --level SESSION \
  --model us.anthropic.claude-sonnet-4-5-20250929-v1:0 \
  --instructions "Evaluate the response quality. Context: {context}" \
  --rating-scale 1-5-quality
```

| Flag                      | Description                                                                |
| ------------------------- | -------------------------------------------------------------------------- |
| `--name <name>`           | Evaluator name                                                             |
| `--level <level>`         | `SESSION`, `TRACE`, or `TOOL_CALL`                                         |
| `--model <model>`         | Bedrock model ID for the LLM judge                                         |
| `--instructions <text>`   | Evaluation prompt with placeholders (e.g. `{context}`)                     |
| `--rating-scale <preset>` | `1-5-quality`, `1-3-simple`, `pass-fail`, `good-neutral-bad`, or custom    |
| `--config <path>`         | Config JSON file (overrides `--model`, `--instructions`, `--rating-scale`) |
| `--json`                  | JSON output                                                                |

### add online-eval

Add an online eval config for continuous agent monitoring.

```bash
agentcore add online-eval \
  --name QualityMonitor \
  --agent MyAgent \
  --evaluator ResponseQuality Builtin.Faithfulness \
  --sampling-rate 10
```

| Flag                         | Description                                   |
| ---------------------------- | --------------------------------------------- |
| `--name <name>`              | Config name                                   |
| `-a, --agent <name>`         | Agent to monitor                              |
| `-e, --evaluator <names...>` | Evaluator name(s), `Builtin.*` IDs, or ARNs   |
| `--evaluator-arn <arns...>`  | Evaluator ARN(s)                              |
| `--sampling-rate <rate>`     | Percentage of requests to evaluate (0.01–100) |
| `--enable-on-create`         | Enable immediately after deploy               |
| `--json`                     | JSON output                                   |

### remove

Remove resources from project.

```bash
agentcore remove agent --name MyAgent --force
agentcore remove memory --name SharedMemory
agentcore remove identity --name OpenAI
agentcore remove evaluator --name ResponseQuality
agentcore remove online-eval --name QualityMonitor
agentcore remove gateway --name MyGateway
agentcore remove gateway-target --name WeatherTools

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

Start local development server with hot-reload.

```bash
agentcore dev
agentcore dev --agent MyAgent --port 3000
agentcore dev --logs                      # Non-interactive
agentcore dev --invoke "Hello" --stream   # Direct invoke

# MCP protocol dev commands
agentcore dev --invoke list-tools
agentcore dev --invoke call-tool --tool myTool --input '{"arg": "value"}'
```

| Flag                    | Description                                            |
| ----------------------- | ------------------------------------------------------ |
| `-p, --port <port>`     | Port (default: 8080; MCP uses 8000, A2A uses 9000)     |
| `-a, --agent <name>`    | Agent to run (required if multiple agents)             |
| `-i, --invoke <prompt>` | Invoke running server                                  |
| `-s, --stream`          | Stream response (with --invoke)                        |
| `-l, --logs`            | Non-interactive stdout logging                         |
| `--tool <name>`         | MCP tool name (with `--invoke call-tool`)              |
| `--input <json>`        | MCP tool arguments as JSON (with `--invoke call-tool`) |

### invoke

Invoke a deployed agent endpoint.

```bash
agentcore invoke "What can you do?"
agentcore invoke --prompt "Hello" --stream
agentcore invoke --agent MyAgent --target staging
agentcore invoke --session-id abc123         # Continue session
agentcore invoke --json                      # JSON output

# MCP protocol invoke
agentcore invoke call-tool --tool myTool --input '{"key": "value"}'
```

| Flag                | Description                                              |
| ------------------- | -------------------------------------------------------- |
| `[prompt]`          | Prompt text (positional argument)                        |
| `--prompt <text>`   | Prompt text (flag, takes precedence over positional)     |
| `--agent <name>`    | Specific agent                                           |
| `--target <name>`   | Deployment target                                        |
| `--session-id <id>` | Continue a specific session                              |
| `--user-id <id>`    | User ID for runtime invocation (default: `default-user`) |
| `--stream`          | Stream response in real-time                             |
| `--tool <name>`     | MCP tool name (use with `call-tool` prompt)              |
| `--input <json>`    | MCP tool arguments as JSON (use with `--tool`)           |
| `--json`            | JSON output                                              |

---

## Observability

### logs

Stream or search agent runtime logs.

```bash
agentcore logs                                   # Stream logs (follow mode)
agentcore logs --agent MyAgent                   # Specific agent
agentcore logs --since 1h --level error          # Search last hour for errors
agentcore logs --since 2d --until 1d --query "timeout"
agentcore logs --json                            # JSON Lines output
```

| Flag              | Description                                                                      |
| ----------------- | -------------------------------------------------------------------------------- |
| `--agent <name>`  | Select specific agent                                                            |
| `--since <time>`  | Start time (defaults to 1h ago in search mode; e.g. `1h`, `30m`, `2d`, ISO 8601) |
| `--until <time>`  | End time (defaults to now in search mode; e.g. `now`, ISO 8601)                  |
| `--level <level>` | Filter by log level: `error`, `warn`, `info`, `debug`                            |
| `-n, --lines <n>` | Maximum number of log lines to return                                            |
| `--query <text>`  | Server-side text filter                                                          |
| `--json`          | Output as JSON Lines                                                             |

### traces

View and download agent traces.

#### traces list

```bash
agentcore traces list
agentcore traces list --agent MyAgent --limit 50
agentcore traces list --since 1h --until now
```

| Flag             | Description                                                                 |
| ---------------- | --------------------------------------------------------------------------- |
| `--agent <name>` | Select specific agent                                                       |
| `--limit <n>`    | Maximum number of traces to display (default: 20)                           |
| `--since <time>` | Start time (defaults to 12h ago; e.g. `5m`, `1h`, `2d`, ISO 8601, epoch ms) |
| `--until <time>` | End time (defaults to now; e.g. `now`, `1h`, ISO 8601, epoch ms)            |

#### traces get

```bash
agentcore traces get <traceId>
agentcore traces get abc123 --agent MyAgent --output ./trace.json
```

| Flag              | Description                      |
| ----------------- | -------------------------------- |
| `<traceId>`       | Trace ID to retrieve (required)  |
| `--agent <name>`  | Select specific agent            |
| `--output <path>` | Output file path                 |
| `--since <time>`  | Start time (defaults to 12h ago) |
| `--until <time>`  | End time (defaults to now)       |

---

## Evaluations

See [Evaluations](evals.md) for the full guide on evaluators, scoring, and online monitoring.

### run evals

Run on-demand evaluation against historical agent traces.

```bash
# Project mode
agentcore run evals --agent MyAgent --evaluator ResponseQuality --days 7

# Standalone mode (no project required)
agentcore run evals \
  --agent-arn arn:aws:...:runtime/abc123 \
  --evaluator-arn arn:aws:...:evaluator/eval123 \
  --region us-east-1
```

| Flag                         | Description                               |
| ---------------------------- | ----------------------------------------- |
| `-a, --agent <name>`         | Agent name from project                   |
| `--agent-arn <arn>`          | Agent runtime ARN (standalone mode)       |
| `-e, --evaluator <names...>` | Evaluator name(s) or `Builtin.*` IDs      |
| `--evaluator-arn <arns...>`  | Evaluator ARN(s) (use with `--agent-arn`) |
| `--region <region>`          | AWS region (required with `--agent-arn`)  |
| `-s, --session-id <id>`      | Evaluate a specific session               |
| `-t, --trace-id <id>`        | Evaluate a specific trace                 |
| `--days <days>`              | Lookback window in days (default: 7)      |
| `--output <path>`            | Custom output file path                   |
| `--json`                     | JSON output                               |

### evals history

View past on-demand eval run results.

```bash
agentcore evals history
agentcore evals history --agent MyAgent --limit 5 --json
```

| Flag                  | Description          |
| --------------------- | -------------------- |
| `-a, --agent <name>`  | Filter by agent name |
| `-n, --limit <count>` | Max runs to display  |
| `--json`              | JSON output          |

### pause online-eval

Pause a deployed online eval config.

```bash
agentcore pause online-eval QualityMonitor
agentcore pause online-eval --arn arn:aws:...:online-eval-config/abc123
```

| Flag                | Description                                        |
| ------------------- | -------------------------------------------------- |
| `[name]`            | Config name from project (not needed with `--arn`) |
| `--arn <arn>`       | Online eval config ARN (standalone mode)           |
| `--region <region>` | AWS region override                                |
| `--json`            | JSON output                                        |

### resume online-eval

Resume a paused online eval config.

```bash
agentcore resume online-eval QualityMonitor
agentcore resume online-eval --arn arn:aws:...:online-eval-config/abc123
```

| Flag                | Description                                        |
| ------------------- | -------------------------------------------------- |
| `[name]`            | Config name from project (not needed with `--arn`) |
| `--arn <arn>`       | Online eval config ARN (standalone mode)           |
| `--region <region>` | AWS region override                                |
| `--json`            | JSON output                                        |

### logs evals

Stream or search online eval logs.

```bash
agentcore logs evals --agent MyAgent --since 1h
agentcore logs evals --follow --json
```

| Flag                  | Description                                   |
| --------------------- | --------------------------------------------- |
| `-a, --agent <name>`  | Filter by agent                               |
| `--since <time>`      | Start time (e.g. `1h`, `30m`, `2d`, ISO 8601) |
| `--until <time>`      | End time                                      |
| `-n, --lines <count>` | Maximum log lines                             |
| `-f, --follow`        | Stream in real-time                           |
| `--json`              | JSON Lines output                             |

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

Check for and install CLI updates.

```bash
agentcore update            # Check and install
agentcore update --check    # Check only, don't install
```

| Flag          | Description                          |
| ------------- | ------------------------------------ |
| `-c, --check` | Check for updates without installing |

### help

Display help topics.

```bash
agentcore help modes   # Explain interactive vs non-interactive modes
```

---

## Common Patterns

### CI/CD Pipeline

```bash
# Validate, preview, and deploy
agentcore validate
agentcore deploy --plan --json        # Preview changes
agentcore deploy -y --json            # Deploy with auto-confirm
```

### Scripted Project Setup

```bash
agentcore create --name MyProject --defaults
cd MyProject
agentcore add memory --name SharedMemory --strategies SEMANTIC
agentcore deploy -y
```

### Gateway Setup

```bash
agentcore add gateway --name MyGateway
agentcore add gateway-target \
  --name WeatherTools \
  --type mcp-server \
  --endpoint https://mcp.example.com/mcp \
  --gateway MyGateway
agentcore deploy -y
```

### Debugging with Traces and Logs

```bash
# Stream runtime logs
agentcore logs --agent MyAgent

# Search for errors in the last 2 hours
agentcore logs --since 2h --level error

# List recent traces
agentcore traces list --agent MyAgent --limit 10

# Download a specific trace
agentcore traces get <traceId> --output ./debug-trace.json
```

### JSON Output for Automation

All commands with `--json` output structured data:

```bash
agentcore status --json | jq '.resources[] | select(.resourceType == "agent")'
agentcore invoke "Hello" --json | jq '.response'
```
