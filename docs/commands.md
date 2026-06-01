# CLI Commands Reference

All commands support non-interactive (scriptable) usage with flags. Use `--json` for machine-readable output.

Run `agentcore` without arguments to launch the interactive TUI. Flags marked `[non-interactive]` trigger CLI mode — run
`agentcore help modes` for details.

## Command Aliases

| Command         | Alias |
| --------------- | ----- |
| `deploy`        | `dp`  |
| `dev`           | `d`   |
| `invoke`        | `i`   |
| `status`        | `s`   |
| `logs`          | `l`   |
| `traces`        | `t`   |
| `package`       | `pkg` |
| `config-bundle` | `cb`  |

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

# TypeScript (Strands or Vercel AI)
agentcore create \
  --name MyTsProject \
  --language TypeScript \
  --framework Strands \
  --model-provider Bedrock

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

| Flag                                  | Description                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--name <name>`                       | Agent (resource) name; also used as project directory name when `--project-name` is omitted                    |
| `--project-name <name>`               | Project directory name (alphanumeric, starts with letter, max 23 chars)                                        |
| `--defaults`                          | Use defaults (Python, Strands, Bedrock, no memory)                                                             |
| `--no-agent`                          | Skip agent creation                                                                                            |
| `--type <type>`                       | `create` (default) or `import`                                                                                 |
| `--language <lang>`                   | `Python` (default) or `TypeScript` (Strands-only; see [Frameworks](frameworks.md#supported-languages))         |
| `--framework <fw>`                    | `Strands`, `LangChain_LangGraph`, `GoogleADK`, `OpenAIAgents`, `VercelAI`                                      |
| `--model-provider <p>`                | `Bedrock`, `Anthropic`, `OpenAI`, `Gemini`                                                                     |
| `--build <type>`                      | `CodeZip` (default) or `Container` (see [Container Builds](container-builds.md))                               |
| `--api-key <key>`                     | API key for non-Bedrock providers                                                                              |
| `--memory <opt>`                      | `none`, `shortTerm`, `longAndShortTerm` (see [Memory Shorthand Mapping](memory.md#--memory-shorthand-mapping)) |
| `--protocol <protocol>`               | `HTTP` (default), `MCP`, `A2A`, `AGUI`                                                                         |
| `--network-mode <mode>`               | `PUBLIC` (default) or `VPC`                                                                                    |
| `--subnets <ids>`                     | Comma-separated subnet IDs (required for VPC mode)                                                             |
| `--security-groups <ids>`             | Comma-separated security group IDs (required for VPC mode)                                                     |
| `--agent-id <id>`                     | Bedrock Agent ID (import only)                                                                                 |
| `--agent-alias-id <id>`               | Bedrock Agent Alias ID (import only)                                                                           |
| `--region <region>`                   | AWS region for Bedrock Agent (import only)                                                                     |
| `--idle-timeout <seconds>`            | Idle session timeout in seconds                                                                                |
| `--max-lifetime <seconds>`            | Max instance lifetime in seconds                                                                               |
| `--session-storage-mount-path <path>` | Absolute mount path for session filesystem storage under `/mnt` (e.g. `/mnt/data`)                             |
| `--with-config-bundle`                | [preview] Create a config bundle wired into the generated agent template                                       |
| `--output-dir <dir>`                  | Output directory                                                                                               |
| `--skip-git`                          | Skip git initialization                                                                                        |
| `--skip-python-setup`                 | Skip venv setup                                                                                                |
| `--skip-install`                      | Skip all dependency installation (npm install, uv sync)                                                        |
| `--dry-run`                           | Preview without creating                                                                                       |
| `--json`                              | JSON output                                                                                                    |

### deploy

Deploy infrastructure to AWS.

```bash
agentcore deploy
agentcore deploy -y                  # Auto-confirm
agentcore deploy -y -v               # Auto-confirm with verbose output
agentcore deploy --dry-run           # Preview without deploying
agentcore deploy --diff              # Show CDK diff without deploying
agentcore deploy --target staging -y # Deploy to a specific target
agentcore deploy -y --json           # JSON output
```

| Flag              | Description                                   |
| ----------------- | --------------------------------------------- |
| `--target <name>` | Deployment target name (default: `"default"`) |
| `-y, --yes`       | Auto-confirm prompts                          |
| `-v, --verbose`   | Resource-level deployment events              |
| `--dry-run`       | Preview deployment without deploying          |
| `--diff`          | Show CDK diff without deploying               |
| `--json`          | JSON output                                   |

### status

Check deployment status and resource details.

```bash
agentcore status
agentcore status --runtime MyAgent
agentcore status --type evaluator
agentcore status --state deployed
agentcore status --runtime-id abc123
agentcore status --json
```

| Flag                | Description                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--runtime-id <id>` | Look up a specific runtime by ID                                                                                           |
| `--target <name>`   | Select deployment target                                                                                                   |
| `--type <type>`     | Filter by resource type: `agent`, `memory`, `credential`, `gateway`, `evaluator`, `online-eval`, `policy-engine`, `policy` |
| `--state <state>`   | Filter by deployment state: `deployed`, `local-only`, `pending-removal`                                                    |
| `--runtime <name>`  | Filter to a specific runtime                                                                                               |
| `--json`            | JSON output                                                                                                                |

### validate

Validate configuration files.

```bash
agentcore validate
agentcore validate -d ./my-project
```

| Flag                     | Description       |
| ------------------------ | ----------------- |
| `-d, --directory <path>` | Project directory |

### import

Import existing AgentCore resources from your AWS account into the project, or migrate from a Bedrock AgentCore Starter
Toolkit project.

```bash
# Import a runtime by ARN
agentcore import runtime \
  --arn arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my-runtime \
  --code ./app/MyAgent \
  --entrypoint main.py \
  --name MyAgent

# Import a memory resource
agentcore import memory --arn arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/abc123 --name SharedMemory

# Import an evaluator
agentcore import evaluator --arn arn:aws:bedrock-agentcore:us-east-1:123456789012:evaluator/eval123 --name ResponseQuality

# Import an online eval config
agentcore import online-eval --arn arn:aws:bedrock-agentcore:us-east-1:123456789012:online-evaluation-config/oec123 --name QualityMonitor

# Import a gateway (with all its targets)
agentcore import gateway --arn arn:aws:bedrock-agentcore:us-east-1:123456789012:gateway/gw123

# Import from a Starter Toolkit project (auto-detects .bedrock_agentcore.yaml in cwd)
agentcore import
agentcore import --source ./path/to/.bedrock_agentcore.yaml -y
```

Top-level flags (apply when running `agentcore import` without a subcommand to migrate a Starter Toolkit project):

| Flag                | Description                                              |
| ------------------- | -------------------------------------------------------- |
| `--source <path>`   | Path to the `.bedrock_agentcore.yaml` configuration file |
| `--target <target>` | Deployment target name (only when project has multiple)  |
| `-y, --yes`         | Auto-confirm prompts                                     |

Subcommand: `import runtime`

| Flag                  | Description                                                            |
| --------------------- | ---------------------------------------------------------------------- |
| `--arn <runtimeArn>`  | Runtime ARN to import                                                  |
| `--code <path>`       | Path to directory containing the entrypoint (e.g. folder with main.py) |
| `--entrypoint <file>` | Entrypoint file (auto-detected from runtime, e.g. `main.py`)           |
| `--name <name>`       | Local name for the imported runtime                                    |
| `-y, --yes`           | Auto-confirm prompts                                                   |

Subcommand: `import memory`

| Flag                | Description                        |
| ------------------- | ---------------------------------- |
| `--arn <memoryArn>` | Memory ARN to import               |
| `--name <name>`     | Local name for the imported memory |
| `-y, --yes`         | Auto-confirm prompts               |

Subcommand: `import evaluator`

| Flag                   | Description                           |
| ---------------------- | ------------------------------------- |
| `--arn <evaluatorArn>` | Evaluator ARN to import               |
| `--name <name>`        | Local name for the imported evaluator |
| `-y, --yes`            | Auto-confirm prompts                  |

Subcommand: `import online-eval`

| Flag                | Description                             |
| ------------------- | --------------------------------------- |
| `--arn <configArn>` | Online evaluation config ARN to import  |
| `--name <name>`     | Local name for the imported online eval |
| `-y, --yes`         | Auto-confirm prompts                    |

Subcommand: `import gateway`

| Flag                 | Description                              |
| -------------------- | ---------------------------------------- |
| `--arn <gatewayArn>` | Gateway ARN to import (with all targets) |

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

| Flag                                   | Description                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <name>`                        | Agent name (alphanumeric + underscores, starts with letter, max 48 chars)                                                                                                                                                                                                                            |
| `--type <type>`                        | `create` (default), `byo`, or `import`                                                                                                                                                                                                                                                               |
| `--build <type>`                       | `CodeZip` (default) or `Container` (see [Container Builds](container-builds.md))                                                                                                                                                                                                                     |
| `--language <lang>`                    | `Python` (create); `Python`, `TypeScript`, `Other` (BYO)                                                                                                                                                                                                                                             |
| `--framework <fw>`                     | `Strands`, `LangChain_LangGraph`, `GoogleADK`, `OpenAIAgents`, `VercelAI`                                                                                                                                                                                                                            |
| `--model-provider <p>`                 | `Bedrock`, `Anthropic`, `OpenAI`, `Gemini`                                                                                                                                                                                                                                                           |
| `--api-key <key>`                      | API key for non-Bedrock providers                                                                                                                                                                                                                                                                    |
| `--memory <opt>`                       | `none`, `shortTerm`, `longAndShortTerm` (create and import; see [Memory Shorthand Mapping](memory.md#--memory-shorthand-mapping))                                                                                                                                                                    |
| `--protocol <protocol>`                | `HTTP` (default), `MCP`, `A2A`, `AGUI`                                                                                                                                                                                                                                                               |
| `--code-location <path>`               | Path to existing code (BYO only)                                                                                                                                                                                                                                                                     |
| `--entrypoint <file>`                  | Entry file relative to code-location (BYO, default: `main.py`)                                                                                                                                                                                                                                       |
| `--network-mode <mode>`                | `PUBLIC` (default) or `VPC`                                                                                                                                                                                                                                                                          |
| `--subnets <ids>`                      | Comma-separated subnet IDs (required for VPC mode)                                                                                                                                                                                                                                                   |
| `--security-groups <ids>`              | Comma-separated security group IDs (required for VPC mode)                                                                                                                                                                                                                                           |
| `--agent-id <id>`                      | Bedrock Agent ID (import only)                                                                                                                                                                                                                                                                       |
| `--agent-alias-id <id>`                | Bedrock Agent Alias ID (import only)                                                                                                                                                                                                                                                                 |
| `--region <region>`                    | AWS region for Bedrock Agent (import only)                                                                                                                                                                                                                                                           |
| `--authorizer-type <type>`             | Inbound auth: `AWS_IAM` or `CUSTOM_JWT`                                                                                                                                                                                                                                                              |
| `--discovery-url <url>`                | OIDC discovery URL (for CUSTOM_JWT)                                                                                                                                                                                                                                                                  |
| `--allowed-audience <vals>`            | Comma-separated allowed audiences (for CUSTOM_JWT)                                                                                                                                                                                                                                                   |
| `--allowed-clients <vals>`             | Comma-separated allowed client IDs (for CUSTOM_JWT)                                                                                                                                                                                                                                                  |
| `--allowed-scopes <scopes>`            | Comma-separated allowed scopes (for CUSTOM_JWT)                                                                                                                                                                                                                                                      |
| `--custom-claims <json>`               | Custom claim validations as JSON array (for CUSTOM_JWT)                                                                                                                                                                                                                                              |
| `--client-id <id>`                     | OAuth client ID for agent bearer token                                                                                                                                                                                                                                                               |
| `--client-secret <secret>`             | OAuth client secret                                                                                                                                                                                                                                                                                  |
| `--request-header-allowlist <headers>` | Comma-separated list of inbound header names to forward to the agent. `X-*` names (e.g. `X-Api-Key`, `X-Custom-Signature`) pass through unchanged; bare names without an `X-` prefix are auto-prefixed with the legacy `X-Amzn-Bedrock-AgentCore-Runtime-Custom-` prefix for backward compatibility. |
| `--session-storage-mount-path <path>`  | Absolute mount path for session filesystem storage (e.g. `/mnt/session-storage`)                                                                                                                                                                                                                     |
| `--with-config-bundle`                 | [preview] Wire a config bundle into the generated agent template                                                                                                                                                                                                                                     |
| `--idle-timeout <seconds>`             | Idle session timeout in seconds                                                                                                                                                                                                                                                                      |
| `--max-lifetime <seconds>`             | Max instance lifetime in seconds                                                                                                                                                                                                                                                                     |
| `--json`                               | JSON output                                                                                                                                                                                                                                                                                          |

### add memory

Add a memory resource.

```bash
agentcore add memory \
  --name SharedMemory \
  --strategies SEMANTIC,SUMMARIZATION \
  --expiry 30
```

| Flag                                 | Description                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `--name <name>`                      | Memory name                                                                 |
| `--strategies <types>`               | Comma-separated: `SEMANTIC`, `SUMMARIZATION`, `USER_PREFERENCE`, `EPISODIC` |
| `--expiry <days>`                    | Event expiry duration in days (default: 30, min: 7, max: 365)               |
| `--delivery-type <type>`             | Delivery target type (default: `kinesis`)                                   |
| `--data-stream-arn <arn>`            | Kinesis data stream ARN for memory record streaming                         |
| `--stream-content-level <level>`     | `FULL_CONTENT` (default) or `METADATA_ONLY`                                 |
| `--stream-delivery-resources <json>` | Stream delivery config as JSON (advanced, overrides flat flags)             |
| `--json`                             | JSON output                                                                 |

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
  --client-id agent-client-id \
  --client-secret agent-client-secret
```

| Flag                          | Description                                                  |
| ----------------------------- | ------------------------------------------------------------ |
| `--name <name>`               | Gateway name                                                 |
| `--description <desc>`        | Gateway description                                          |
| `--runtimes <names>`          | Comma-separated runtime names to expose through this gateway |
| `--authorizer-type <type>`    | `NONE` (default), `AWS_IAM`, or `CUSTOM_JWT`                 |
| `--discovery-url <url>`       | OIDC discovery URL (required for CUSTOM_JWT)                 |
| `--allowed-audience <values>` | Comma-separated allowed audiences (required for CUSTOM_JWT)  |
| `--allowed-clients <values>`  | Comma-separated allowed client IDs (required for CUSTOM_JWT) |
| `--allowed-scopes <scopes>`   | Comma-separated allowed scopes (optional for CUSTOM_JWT)     |
| `--custom-claims <json>`      | Custom claim validations as JSON array (CUSTOM_JWT)          |
| `--client-id <id>`            | OAuth client ID for gateway bearer tokens (CUSTOM_JWT)       |
| `--client-secret <secret>`    | OAuth client secret for gateway bearer tokens (CUSTOM_JWT)   |
| `--no-semantic-search`        | Disable semantic search for tool discovery                   |
| `--exception-level <level>`   | Exception verbosity level: `NONE` (default) or `DEBUG`       |
| `--policy-engine <name>`      | Policy engine name for Cedar-based authorization             |
| `--policy-engine-mode <mode>` | Policy engine mode: `LOG_ONLY` or `ENFORCE`                  |
| `--json`                      | JSON output                                                  |

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

| Flag                              | Description                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `--name <name>`                   | Target name                                                                                                   |
| `--description <desc>`            | Target description                                                                                            |
| `--type <type>`                   | Target type (required): `mcp-server`, `api-gateway`, `open-api-schema`, `smithy-model`, `lambda-function-arn` |
| `--endpoint <url>`                | MCP server endpoint URL (mcp-server)                                                                          |
| `--language <lang>`               | Implementation language: Python, TypeScript, Other (mcp-server)                                               |
| `--host <host>`                   | Compute host: Lambda or AgentCoreRuntime (mcp-server)                                                         |
| `--gateway <name>`                | Gateway to attach target to                                                                                   |
| `--outbound-auth <type>`          | `oauth`, `api-key`, or `none` (varies by target type)                                                         |
| `--credential-name <name>`        | Existing credential name for outbound auth                                                                    |
| `--oauth-client-id <id>`          | OAuth client ID (creates credential inline)                                                                   |
| `--oauth-client-secret <secret>`  | OAuth client secret (creates credential inline)                                                               |
| `--oauth-discovery-url <url>`     | OAuth discovery URL (creates credential inline)                                                               |
| `--oauth-scopes <scopes>`         | OAuth scopes, comma-separated                                                                                 |
| `--rest-api-id <id>`              | API Gateway REST API ID (api-gateway)                                                                         |
| `--stage <stage>`                 | API Gateway stage name (api-gateway)                                                                          |
| `--tool-filter-path <path>`       | Filter API paths, supports wildcards (api-gateway)                                                            |
| `--tool-filter-methods <methods>` | Comma-separated HTTP methods to expose (api-gateway)                                                          |
| `--schema <path>`                 | Path to schema file, relative to project root (open-api-schema, smithy-model)                                 |
| `--schema-s3-account <account>`   | AWS account for S3-hosted schema (open-api-schema, smithy-model)                                              |
| `--lambda-arn <arn>`              | Lambda function ARN (lambda-function-arn)                                                                     |
| `--tool-schema-file <path>`       | Tool schema file, relative to project root or absolute path (lambda-function-arn)                             |
| `--json`                          | JSON output                                                                                                   |

> **Note**: `smithy-model` and `lambda-function-arn` use IAM role auth and do not support `--outbound-auth`.
> `open-api-schema` requires `--outbound-auth` (`oauth` or `api-key`). `api-gateway` supports `api-key` or `none`.
> `mcp-server` supports `oauth` or `none`.

### add credential

Add a credential to the project. Supports API key and OAuth credential types.

```bash
# API key credential
agentcore add credential \
  --name OpenAI \
  --api-key sk-...

# OAuth credential
agentcore add credential \
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

Add a custom evaluator. Two types are supported: `llm-as-a-judge` (default) and `code-based` (Lambda). See
[Evaluations](evals.md) for full details.

```bash
# LLM-as-a-Judge
agentcore add evaluator \
  --name ResponseQuality \
  --level SESSION \
  --model us.anthropic.claude-sonnet-4-5-20250514-v1:0 \
  --instructions "Evaluate the response quality. Context: {context}" \
  --rating-scale 1-5-quality

# Code-based (existing Lambda)
agentcore add evaluator \
  --name LatencyCheck \
  --type code-based \
  --level TRACE \
  --lambda-arn arn:aws:lambda:us-east-1:123456789012:function:my-evaluator \
  --timeout 60
```

| Flag                      | Description                                                                   |
| ------------------------- | ----------------------------------------------------------------------------- |
| `--name <name>`           | Evaluator name                                                                |
| `--type <type>`           | `llm-as-a-judge` (default) or `code-based`                                    |
| `--level <level>`         | `SESSION`, `TRACE`, or `TOOL_CALL`                                            |
| `--model <model>`         | [LLM] Bedrock model ID for the LLM judge                                      |
| `--instructions <text>`   | [LLM] Evaluation prompt with placeholders (e.g. `{context}`)                  |
| `--rating-scale <preset>` | [LLM] `1-5-quality`, `1-3-simple`, `pass-fail`, `good-neutral-bad`, or custom |
| `--lambda-arn <arn>`      | [Code-based] Existing Lambda function ARN                                     |
| `--timeout <seconds>`     | [Code-based] Lambda timeout in seconds (1–300)                                |
| `--kms-key-arn <arn>`     | KMS key ARN for evaluator encryption (optional)                               |
| `--config <path>`         | Config JSON file (overrides `--model`, `--instructions`, `--rating-scale`)    |
| `--json`                  | JSON output                                                                   |

### add online-eval

Add an online eval config for continuous agent monitoring.

```bash
agentcore add online-eval \
  --name QualityMonitor \
  --runtime MyAgent \
  --evaluator ResponseQuality Builtin.Faithfulness \
  --sampling-rate 10
```

| Flag                         | Description                                   |
| ---------------------------- | --------------------------------------------- |
| `--name <name>`              | Config name                                   |
| `-r, --runtime <name>`       | Runtime to monitor                            |
| `-e, --evaluator <names...>` | Evaluator name(s), `Builtin.*` IDs, or ARNs   |
| `--evaluator-arn <arns...>`  | Evaluator ARN(s)                              |
| `--sampling-rate <rate>`     | Percentage of requests to evaluate (0.01–100) |
| `--endpoint <name>`          | Runtime endpoint name to scope monitoring     |
| `--enable-on-create`         | Enable immediately after deploy               |
| `--json`                     | JSON output                                   |

### add policy-engine

Add a Cedar policy engine to the project. Policy engines provide authorization for gateway requests using Cedar
policies.

```bash
agentcore add policy-engine \
  --name MyPolicyEngine \
  --description "Authorization for production gateways" \
  --attach-to-gateways MyGateway,OtherGateway \
  --attach-mode ENFORCE
```

| Flag                              | Description                                                     |
| --------------------------------- | --------------------------------------------------------------- |
| `--name <name>`                   | Policy engine name                                              |
| `--description <desc>`            | Policy engine description                                       |
| `--encryption-key-arn <arn>`      | KMS encryption key ARN                                          |
| `--attach-to-gateways <gateways>` | Comma-separated gateway names to attach this engine to          |
| `--attach-mode <mode>`            | Enforcement mode for attached gateways: `LOG_ONLY` or `ENFORCE` |
| `--json`                          | JSON output                                                     |

### add policy

Add a Cedar policy to a policy engine. Policies can be authored inline, loaded from a file, or generated from a natural
language description.

```bash
# From a Cedar policy file
agentcore add policy \
  --name AdminAccess \
  --engine MyPolicyEngine \
  --source ./policies/admin.cedar

# Inline statement
agentcore add policy \
  --name DenyDelete \
  --engine MyPolicyEngine \
  --statement 'forbid(principal, action == Action::"Delete", resource);'

# Generate from natural language (uses a deployed gateway as context)
agentcore add policy \
  --name ReadOnlyForGuests \
  --engine MyPolicyEngine \
  --generate "Allow guests to read but never write or delete" \
  --gateway MyGateway
```

| Flag                       | Description                                                          |
| -------------------------- | -------------------------------------------------------------------- |
| `--name <name>`            | Policy name                                                          |
| `--engine <engine>`        | Policy engine name (must already exist)                              |
| `--description <desc>`     | Policy description                                                   |
| `--source <path>`          | Path to a Cedar policy file                                          |
| `--statement <cedar>`      | Cedar policy statement (inline)                                      |
| `-g, --generate <prompt>`  | Generate Cedar policy from natural language description              |
| `--gateway <name>`         | Deployed gateway name for policy generation (used with `--generate`) |
| `--validation-mode <mode>` | Validation mode: `FAIL_ON_ANY_FINDINGS` or `IGNORE_ALL_FINDINGS`     |
| `--json`                   | JSON output                                                          |

### add runtime-endpoint

Add a named endpoint (version alias) to a deployed runtime. Endpoints let you address specific runtime versions by name
(e.g. `prod`, `staging`).

```bash
agentcore add runtime-endpoint \
  --runtime MyAgent \
  --endpoint prod \
  --version 3 \
  --description "Production endpoint pinned to version 3"
```

| Flag                   | Description                            |
| ---------------------- | -------------------------------------- |
| `--runtime <name>`     | Runtime to add the endpoint to         |
| `--endpoint <name>`    | Endpoint name (e.g. `prod`, `staging`) |
| `--version <number>`   | Version number to alias (default: `1`) |
| `--description <desc>` | Description of the endpoint            |
| `--json`               | JSON output                            |

### add dataset

Add a dataset to the project. Datasets are used to drive batch evaluations and recommendations with a curated set of
inputs.

```bash
agentcore add dataset \
  --name MyDataset \
  --schema-type AGENTCORE_EVALUATION_PREDEFINED_V1 \
  --description "Customer support smoke tests"
```

| Flag                          | Description                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- |
| `--name <name>`               | Dataset name                                                                |
| `--schema-type <schemaType>`  | `AGENTCORE_EVALUATION_PREDEFINED_V1` or `AGENTCORE_EVALUATION_SIMULATED_V1` |
| `--description <description>` | Dataset description                                                         |
| `--kms-key-arn <arn>`         | KMS key ARN for dataset encryption (optional)                               |
| `--json`                      | JSON output                                                                 |

### add config-bundle

[preview] Add a configuration bundle. Config bundles snapshot system prompts, tool descriptions, and runtime config so
they can be versioned and used as A/B test arms.

```bash
agentcore add config-bundle \
  --name MyBundle \
  --components-file ./bundle-components.json \
  --commit-message "Initial bundle"
```

| Flag                       | Description                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--name <name>`            | Bundle name                                                                                                                   |
| `--description <text>`     | Bundle description                                                                                                            |
| `--components <json>`      | Components map as inline JSON. Keys are ARNs or placeholders: `{{runtime:<name>}}`, `{{gateway:<name>}}`. Resolved at deploy. |
| `--components-file <path>` | Path to a components JSON file (same format as `--components`)                                                                |
| `--branch <name>`          | Branch name for versioning                                                                                                    |
| `--commit-message <text>`  | Commit message for this version                                                                                               |
| `--json`                   | JSON output                                                                                                                   |

### add ab-test

[preview] Add an A/B test. Two modes: `config-bundle` (default; split traffic between two bundle versions) and
`target-based` (split traffic between two HTTP gateway targets).

```bash
agentcore add ab-test \
  --name PromptComparison \
  --runtime MyAgent \
  --control-bundle ProdBundle --control-version 5 \
  --treatment-bundle ExperimentalBundle --treatment-version 2 \
  --control-weight 80 --treatment-weight 20 \
  --enable
```

| Flag                        | Description                                               |
| --------------------------- | --------------------------------------------------------- |
| `--mode <mode>`             | `config-bundle` (default) or `target-based`               |
| `--name <name>`             | AB test name                                              |
| `--description <text>`      | AB test description                                       |
| `--role-arn <arn>`          | IAM role ARN (auto-created if omitted)                    |
| `--control-weight <n>`      | Traffic weight for control (1–100)                        |
| `--treatment-weight <n>`    | Traffic weight for treatment (1–100)                      |
| `--gateway <name>`          | HTTP gateway name                                         |
| `--enable`                  | Enable the AB test on creation                            |
| `--runtime <name>`          | (config-bundle mode) Runtime agent to A/B test            |
| `--control-bundle <name>`   | (config-bundle mode) Control config bundle name or ARN    |
| `--control-version <id>`    | (config-bundle mode) Control config bundle version        |
| `--treatment-bundle <name>` | (config-bundle mode) Treatment config bundle name or ARN  |
| `--treatment-version <id>`  | (config-bundle mode) Treatment config bundle version      |
| `--online-eval <name>`      | (config-bundle mode) Online evaluation config name or ARN |
| `--traffic-header <name>`   | (config-bundle mode) Header name for traffic routing      |
| `--json`                    | JSON output                                               |

### remove

Remove resources from project.

```bash
agentcore remove agent --name MyAgent -y
agentcore remove memory --name SharedMemory
agentcore remove credential --name OpenAI
agentcore remove evaluator --name ResponseQuality
agentcore remove online-eval --name QualityMonitor
agentcore remove gateway --name MyGateway
agentcore remove gateway-target --name WeatherTools
agentcore remove policy-engine --name MyPolicyEngine
agentcore remove policy --name AdminAccess --engine MyPolicyEngine
agentcore remove runtime-endpoint --name prod
agentcore remove dataset --name MyDataset
agentcore remove config-bundle --name MyBundle
agentcore remove ab-test --name PromptComparison

# Reset everything
agentcore remove all -y
agentcore remove all --dry-run  # Preview
```

| Flag                | Description                                       |
| ------------------- | ------------------------------------------------- |
| `--name <name>`     | Resource name                                     |
| `--engine <engine>` | Policy engine name (required for `remove policy`) |
| `-y, --yes`         | Skip confirmation                                 |
| `--dry-run`         | Preview (`remove all` only)                       |
| `--json`            | JSON output                                       |

---

## Development

### dev

Start local development server with hot-reload.

```bash
agentcore dev
agentcore dev --runtime MyAgent --port 3000
agentcore dev --logs                      # Non-interactive
agentcore dev "Hello" --stream            # Invoke running dev server
agentcore dev "Hello" --runtime MyAgent    # Invoke specific runtime

# MCP protocol dev commands
agentcore dev list-tools
agentcore dev call-tool --tool myTool --input '{"arg": "value"}'
```

| Flag / Argument        | Description                                                           |
| ---------------------- | --------------------------------------------------------------------- |
| `[prompt]`             | Send a prompt to a running dev server                                 |
| `-p, --port <port>`    | Port (default: 8080; MCP uses 8000, A2A uses 9000)                    |
| `-r, --runtime <name>` | Runtime to run or invoke (required if multiple runtimes)              |
| `-s, --stream`         | Stream response when invoking                                         |
| `-l, --logs`           | Non-interactive stdout logging                                        |
| `--tool <name>`        | MCP tool name (with `call-tool` prompt)                               |
| `--input <json>`       | MCP tool arguments as JSON (with `--tool`)                            |
| `-H, --header <h>`     | Custom header (`"Name: Value"`, repeatable)                           |
| `--exec`               | Execute a shell command in the running dev container (Container only) |
| `-b, --no-browser`     | Use terminal TUI instead of web-based chat UI                         |
| `--no-traces`          | Disable local OTEL trace collection                                   |

### invoke

Invoke a deployed agent endpoint.

```bash
agentcore invoke "What can you do?"
agentcore invoke --prompt "Hello" --stream
agentcore invoke --runtime MyAgent --target staging
agentcore invoke --session-id abc123         # Continue session
agentcore invoke --json                      # JSON output

# Long prompts: read from a file or pipe from stdin
agentcore invoke --prompt-file prompt.json --json
cat long-prompt.txt | agentcore invoke --json
jq -r '.response' result.json | agentcore invoke --json

# MCP protocol invoke
agentcore invoke call-tool --tool myTool --input '{"key": "value"}'

# Execute shell commands in the runtime container
agentcore invoke --exec "ls -la /app"
agentcore invoke --exec "python script.py" --timeout 120
agentcore invoke --exec "cat /etc/os-release" --json
```

The prompt can come from four sources, resolved in this precedence order: `--prompt` > positional > `--prompt-file` >
piped stdin. `--prompt-file` combined with piped stdin content returns a collision error — pick one.

| Flag                   | Description                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| `[prompt]`             | Prompt text (positional argument)                                |
| `--prompt <text>`      | Prompt text (flag, takes precedence over positional)             |
| `--prompt-file <path>` | Read the prompt from a file (useful for long / structured input) |
| `--runtime <name>`     | Specific runtime                                                 |
| `--target <name>`      | Deployment target                                                |
| `--session-id <id>`    | Continue a specific session                                      |
| `--user-id <id>`       | User ID for runtime invocation (default: `default-user`)         |
| `--stream`             | Stream response in real-time                                     |
| `--tool <name>`        | MCP tool name (use with `call-tool` prompt)                      |
| `--input <json>`       | MCP tool arguments as JSON (use with `--tool`)                   |
| `-H, --header <h>`     | Custom header (`"Name: Value"`, repeatable)                      |
| `--bearer-token <t>`   | Bearer token for CUSTOM_JWT auth                                 |
| `--exec`               | Execute a shell command in the runtime container                 |
| `--timeout <seconds>`  | Timeout in seconds for `--exec` commands                         |
| `--json`               | JSON output                                                      |

Piped stdin is auto-detected: when no prompt is supplied and stdin is not a TTY, the prompt is read from stdin.

---

## Observability

### logs

Stream or search agent runtime logs.

```bash
agentcore logs                                   # Stream logs (follow mode)
agentcore logs --runtime MyAgent                  # Specific runtime
agentcore logs --since 1h --level error          # Search last hour for errors
agentcore logs --since 2d --until 1d --query "timeout"
agentcore logs --json                            # JSON Lines output
```

| Flag               | Description                                                                      |
| ------------------ | -------------------------------------------------------------------------------- |
| `--runtime <name>` | Select specific runtime                                                          |
| `--since <time>`   | Start time (defaults to 1h ago in search mode; e.g. `1h`, `30m`, `2d`, ISO 8601) |
| `--until <time>`   | End time (defaults to now in search mode; e.g. `now`, ISO 8601)                  |
| `--level <level>`  | Filter by log level: `error`, `warn`, `info`, `debug`                            |
| `-n, --limit <n>`  | Maximum number of log lines to return                                            |
| `--query <text>`   | Server-side text filter                                                          |
| `--json`           | Output as JSON Lines                                                             |

### traces

View and download agent traces.

#### traces list

```bash
agentcore traces list
agentcore traces list --runtime MyAgent --limit 50
agentcore traces list --since 1h --until now
```

| Flag               | Description                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| `--runtime <name>` | Select specific runtime                                                     |
| `--limit <n>`      | Maximum number of traces to display (default: 20)                           |
| `--since <time>`   | Start time (defaults to 12h ago; e.g. `5m`, `1h`, `2d`, ISO 8601, epoch ms) |
| `--until <time>`   | End time (defaults to now; e.g. `now`, `1h`, ISO 8601, epoch ms)            |

#### traces get

```bash
agentcore traces get <traceId>
agentcore traces get abc123 --runtime MyAgent --output ./trace.json
```

| Flag               | Description                      |
| ------------------ | -------------------------------- |
| `<traceId>`        | Trace ID to retrieve (required)  |
| `--runtime <name>` | Select specific runtime          |
| `--output <path>`  | Output file path                 |
| `--since <time>`   | Start time (defaults to 12h ago) |
| `--until <time>`   | End time (defaults to now)       |

---

## Evaluations

See [Evaluations](evals.md) for the full guide on evaluators, scoring, and online monitoring.

### run eval

Run on-demand evaluation against historical agent traces.

```bash
# Project mode
agentcore run eval --runtime MyAgent --evaluator ResponseQuality --days 7

# Standalone mode (no project required)
agentcore run eval \
  --runtime-arn arn:aws:...:runtime/abc123 \
  --evaluator-arn arn:aws:...:evaluator/eval123 \
  --region us-east-1
```

| Flag                            | Description                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `-r, --runtime <name>`          | Runtime name from project                                                                                  |
| `--runtime-arn <arn>`           | Runtime ARN (standalone mode)                                                                              |
| `-e, --evaluator <names...>`    | Evaluator name(s) or `Builtin.*` IDs                                                                       |
| `--evaluator-arn <arns...>`     | Evaluator ARN(s) (use with `--runtime-arn`)                                                                |
| `--region <region>`             | AWS region (required with `--runtime-arn`)                                                                 |
| `-s, --session-id <id>`         | Evaluate a specific session                                                                                |
| `-t, --trace-id <id>`           | Evaluate a specific trace                                                                                  |
| `--endpoint <name>`             | Runtime endpoint name (e.g. `PROMPT_V1`); defaults to `AGENTCORE_RUNTIME_ENDPOINT` env var, then `DEFAULT` |
| `--days <days>`                 | Lookback window in days (default: 7)                                                                       |
| `-A, --assertion <text...>`     | Ground truth assertion the agent response must satisfy (repeatable)                                        |
| `--expected-trajectory <names>` | Ground truth: expected tool call names in order (comma-separated)                                          |
| `--expected-response <text>`    | Ground truth: expected agent response text to compare against                                              |
| `--output <path>`               | Custom output file path                                                                                    |
| `--json`                        | JSON output                                                                                                |

### run batch-evaluation

[preview] Run evaluators in batch across all agent sessions found in CloudWatch.

```bash
# Single evaluator across recent sessions
agentcore run batch-evaluation -r MyAgent -e Builtin.Correctness

# Multiple evaluators with a custom run name
agentcore run batch-evaluation \
  -r MyAgent \
  -e Builtin.Correctness Builtin.Faithfulness \
  -n "weekly-check" \
  --json

# Drive batch evaluation with a dataset
agentcore run batch-evaluation \
  -r MyAgent \
  -e Builtin.Completeness \
  --dataset MyDataset --dataset-version DRAFT
```

| Flag                          | Description                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `-r, --runtime <name>`        | Runtime name from project config                                                                       |
| `-e, --evaluator <ids...>`    | Evaluator name(s) — `Builtin.*` IDs                                                                    |
| `-n, --name <name>`           | Name for the batch evaluation (auto-generated if omitted)                                              |
| `-d, --lookback-days <days>`  | Lookback window in days                                                                                |
| `-s, --session-ids <ids...>`  | Specific session IDs to evaluate                                                                       |
| `-g, --ground-truth <path>`   | JSON file with session metadata and ground truth (assertions, expected trajectory, turns)              |
| `--region <region>`           | AWS region (auto-detected if omitted)                                                                  |
| `--endpoint <name>`           | Runtime endpoint name (e.g. `PROMPT_V1`); defaults to `AGENTCORE_RUNTIME_ENDPOINT` env, then `DEFAULT` |
| `--dataset <name>`            | Dataset name — invoke agent with dataset scenarios before batch evaluation                             |
| `--dataset-version <version>` | Dataset version (omit for local file, or `N`/`DRAFT`)                                                  |
| `--json`                      | JSON output                                                                                            |

### run recommendation

[preview] Optimize a system prompt or tool descriptions using agent traces as the signal.

```bash
# Optimize a system prompt from an inline string
agentcore run recommendation \
  -t system-prompt \
  -r MyAgent \
  -e Builtin.Correctness \
  --inline "You are a helpful assistant"

# Optimize a system prompt from a file
agentcore run recommendation \
  -t system-prompt \
  -r MyAgent \
  -e Builtin.Correctness \
  --prompt-file ./prompt.txt

# Optimize tool descriptions
agentcore run recommendation \
  -t tool-description \
  -r MyAgent \
  --tools "search:Searches the web" --tools "calc:Does math"

# Optimize from a deployed config bundle
agentcore run recommendation \
  -t system-prompt \
  -r MyAgent \
  -e Builtin.Correctness \
  --bundle-name MyBundle
```

| Flag                               | Description                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `-t, --type <type>`                | What to optimize: `system-prompt` or `tool-description` (default: `system-prompt`)                                             |
| `-r, --runtime <name>`             | Runtime name from project config                                                                                               |
| `-e, --evaluator <name>`           | Evaluator name — required for `system-prompt` (exactly one)                                                                    |
| `--prompt-file <path>`             | Load the current system prompt from a file                                                                                     |
| `--inline <content>`               | Provide the current system prompt or tool descriptions inline                                                                  |
| `--bundle-name <name>`             | Read current content from a deployed config bundle                                                                             |
| `--bundle-version <version>`       | Config bundle version (with `--bundle-name`)                                                                                   |
| `--system-prompt-json-path <path>` | Field name under `configuration` in the bundle (e.g. `systemPrompt`). Resolved automatically. Use dot notation only.           |
| `--tool-desc-json-path <pair...>`  | Tool name:field pairs for tool descriptions in a config bundle (e.g. `--tool-desc-json-path "search:searchDesc"`). Repeatable. |
| `--tools <pair...>`                | Tool name:description pairs (repeatable, e.g. `--tools "search:Searches the web"`)                                             |
| `--spans-file <path>`              | JSON file with OTEL session spans (use instead of CloudWatch traces)                                                           |
| `--lookback <days>`                | How far back to search for traces in CloudWatch, in days (default: `7`)                                                        |
| `-s, --session-id <ids...>`        | Limit trace collection to specific session IDs                                                                                 |
| `-n, --run <name>`                 | Run name prefix for the recommendation                                                                                         |
| `--region <region>`                | AWS region                                                                                                                     |
| `--json`                           | JSON output                                                                                                                    |

### recommendations history

[preview] Show past recommendation runs saved locally.

```bash
agentcore recommendations history
agentcore recommendations history --json
```

| Flag     | Description |
| -------- | ----------- |
| `--json` | JSON output |

### evals history

View past on-demand eval run results.

```bash
agentcore evals history
agentcore evals history --runtime MyAgent --limit 5 --json
```

| Flag                   | Description            |
| ---------------------- | ---------------------- |
| `-r, --runtime <name>` | Filter by runtime name |
| `-n, --limit <count>`  | Max runs to display    |
| `--json`               | JSON output            |

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
agentcore logs evals --runtime MyAgent --since 1h
agentcore logs evals --follow --json
```

| Flag                   | Description                                   |
| ---------------------- | --------------------------------------------- |
| `-r, --runtime <name>` | Filter by runtime                             |
| `--since <time>`       | Start time (e.g. `1h`, `30m`, `2d`, ISO 8601) |
| `--until <time>`       | End time                                      |
| `-n, --limit <count>`  | Maximum log lines                             |
| `-f, --follow`         | Stream in real-time                           |
| `--json`               | JSON Lines output                             |

---

## Lifecycle & A/B Testing

### stop

Stop a running batch evaluation or a deployed A/B test.

```bash
# Stop a running batch evaluation
agentcore stop batch-evaluation -i <batch-eval-id>
agentcore stop batch-evaluation -i <batch-eval-id> --json

# Stop a deployed A/B test (permanent)
agentcore stop ab-test PromptComparison
```

#### `stop batch-evaluation`

| Flag                | Description                           |
| ------------------- | ------------------------------------- |
| `-i, --id <id>`     | Batch evaluation ID to stop           |
| `--region <region>` | AWS region (auto-detected if omitted) |
| `--json`            | JSON output                           |

#### `stop ab-test`

| Argument / Flag     | Description  |
| ------------------- | ------------ |
| `<name>`            | AB test name |
| `--region <region>` | AWS region   |
| `--json`            | JSON output  |

### archive

[preview] Archive (delete) a batch evaluation or recommendation on the service and clear local history. Irreversible.

```bash
# Archive a batch evaluation
agentcore archive batch-evaluation -i <batch-eval-id>
agentcore archive batch-evaluation -i <batch-eval-id> --region us-west-2 --json

# Archive a recommendation
agentcore archive recommendation -i <recommendation-id>
```

Both `archive batch-evaluation` and `archive recommendation` accept the same flags:

| Flag                | Description                                  |
| ------------------- | -------------------------------------------- |
| `-i, --id <id>`     | ID of the batch evaluation or recommendation |
| `--region <region>` | AWS region (auto-detected if omitted)        |
| `--json`            | JSON output                                  |

### ab-test

[preview] View A/B test details and results.

```bash
agentcore ab-test PromptComparison
agentcore ab-test PromptComparison --json
```

| Argument / Flag     | Description  |
| ------------------- | ------------ |
| `<name>`            | AB test name |
| `--region <region>` | AWS region   |
| `--json`            | JSON output  |

### config-bundle

[preview] Manage configuration bundles. Use the bundle name from `agentcore.json`, not the bundle ID. Aliased as `cb`.

```bash
# List version history
agentcore config-bundle versions --bundle MyBundle
agentcore cb versions --bundle MyBundle --latest-per-branch --json

# Diff two versions
agentcore config-bundle diff --bundle MyBundle --from <versionId> --to <versionId>

# Create a new branch from an existing version
agentcore config-bundle create-branch \
  --bundle MyBundle \
  --branch experimental \
  --from <parentVersionId> \
  --commit-message "Branch off prod for experiments"
```

#### `config-bundle versions`

| Flag                  | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `--bundle <name>`     | Bundle name as defined in `agentcore.json`             |
| `--branch <name>`     | Filter by branch name                                  |
| `--latest-per-branch` | Show only the latest version per branch                |
| `--created-by <name>` | Filter by creator name (e.g. `user`, `recommendation`) |
| `--region <region>`   | AWS region override                                    |
| `--json`              | JSON output                                            |

#### `config-bundle diff`

| Flag                | Description                                   |
| ------------------- | --------------------------------------------- |
| `--bundle <name>`   | Bundle name                                   |
| `--from <id>`       | Source version ID (from `cb versions --json`) |
| `--to <id>`         | Target version ID (from `cb versions --json`) |
| `--region <region>` | AWS region override                           |
| `--json`            | JSON output                                   |

#### `config-bundle create-branch`

| Flag                      | Description                                           |
| ------------------------- | ----------------------------------------------------- |
| `--bundle <name>`         | Bundle name                                           |
| `--branch <name>`         | Name for the new branch                               |
| `--from <versionId>`      | Parent version ID to branch from (defaults to latest) |
| `--commit-message <text>` | Commit message for the branch point                   |
| `--region <region>`       | AWS region override                                   |
| `--json`                  | JSON output                                           |

### dataset

Manage dataset content and versions. Use `add dataset` / `remove dataset` to create or delete dataset resources in the
project.

```bash
# Pull DRAFT contents to a local file
agentcore dataset download --name MyDataset

# Pull a specific version
agentcore dataset download --name MyDataset --version 3 --yes --json

# Promote DRAFT to a new immutable version
agentcore dataset publish-version --name MyDataset --json

# Delete a published version
agentcore dataset remove-version 2 --name MyDataset
```

#### `dataset download`

| Flag                  | Description                        |
| --------------------- | ---------------------------------- |
| `--name <name>`       | Dataset name                       |
| `--version <version>` | Version to pull (default: `DRAFT`) |
| `--yes`               | Skip overwrite confirmation        |
| `--json`              | JSON output                        |

#### `dataset publish-version`

| Flag            | Description  |
| --------------- | ------------ |
| `--name <name>` | Dataset name |
| `--json`        | JSON output  |

#### `dataset remove-version`

| Argument / Flag | Description              |
| --------------- | ------------------------ |
| `<version-id>`  | Version number to remove |
| `--name <name>` | Dataset name             |
| `--json`        | JSON output              |

---

## Utilities

### fetch access

Fetch access info (URL, token, auth guidance) for a deployed gateway or agent.

```bash
agentcore fetch access
agentcore fetch access --name MyGateway --type gateway --json
agentcore fetch access --name MyAgent --type agent --target staging
```

| Flag                     | Description                                   |
| ------------------------ | --------------------------------------------- |
| `--name <name>`          | Gateway or agent name                         |
| `--type <type>`          | Resource type: `gateway` (default) or `agent` |
| `--target <name>`        | Deployment target                             |
| `--identity-name <name>` | Identity credential name for token fetch      |
| `--json`                 | JSON output                                   |

### package

Package agent artifacts without deploying.

```bash
agentcore package
agentcore package --runtime MyAgent
agentcore package -d ./my-project
```

| Flag                     | Description              |
| ------------------------ | ------------------------ |
| `-d, --directory <path>` | Project directory        |
| `-r, --runtime <name>`   | Package specific runtime |

### feedback

Send feedback about the AgentCore CLI. The CLI displays the AWS Customer Agreement and prompts for consent before
submitting; consent must be confirmed in an interactive terminal.

```bash
agentcore feedback "the dev server is slow on Linux"
agentcore feedback "broken icon" --screenshot ~/Desktop/bug.png
agentcore feedback "automation works" --json
agentcore feedback                                       # launches the wizard
```

| Flag                  | Description                                                  |
| --------------------- | ------------------------------------------------------------ |
| `--screenshot <path>` | Path to a `.png`, `.jpg`, or `.jpeg` file (max 100MB)        |
| `--json`              | Print result as JSON (`{success, id, timestamp, reference}`) |

See [docs/feedback.md](feedback.md) for usage details.

### update

Check for and install CLI updates. Equivalent to `agentcore update cli`.

```bash
agentcore update                # Check and install
agentcore update --check        # Check only, don't install
agentcore update cli            # Same as `agentcore update`
agentcore update cli --check    # Same as `agentcore update --check`
```

| Flag          | Description                          |
| ------------- | ------------------------------------ |
| `-c, --check` | Check for updates without installing |

### telemetry

Manage anonymous usage analytics preferences. Telemetry is opt-in and used to improve the CLI.

```bash
agentcore telemetry status      # Show current preference and where it was set
agentcore telemetry enable      # Opt in
agentcore telemetry disable     # Opt out
```

`enable`, `disable`, and `status` take no flags beyond `-h, --help`. The preference is stored in your global CLI config
and persists across projects.

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
agentcore deploy --dry-run --json     # Preview changes
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
agentcore logs --runtime MyAgent

# Search for errors in the last 2 hours
agentcore logs --since 2h --level error

# List recent traces
agentcore traces list --runtime MyAgent --limit 10

# Download a specific trace
agentcore traces get <traceId> --output ./debug-trace.json
```

### JSON Output for Automation

All commands with `--json` output structured data:

```bash
agentcore status --json | jq '.resources[] | select(.resourceType == "agent")'
agentcore invoke "Hello" --json | jq '.response'
```
