# Configuration Reference

AgentCore projects use JSON configuration files in the `agentcore/` directory.

## Files Overview

| File                       | Purpose                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `agentcore.json`           | Project, agents, memories, credentials, evaluators, online evals, gateways |
| `aws-targets.json`         | Deployment targets                                                         |
| `.cli/deployed-state.json` | Runtime state (auto-managed, do not edit)                                  |
| `.env.local`               | API keys for local development (gitignored)                                |

---

## agentcore.json

Main project configuration using a **flat resource model**. Agents, memories, and credentials are top-level arrays.

```json
{
  "name": "MyProject",
  "version": 1,
  "tags": {
    "agentcore:created-by": "agentcore-cli",
    "agentcore:project-name": "MyProject"
  },
  "runtimes": [
    {
      "name": "MyAgent",
      "build": "CodeZip",
      "entrypoint": "main.py",
      "codeLocation": "app/MyAgent/",
      "runtimeVersion": "PYTHON_3_14",
      "networkMode": "PUBLIC",
      "protocol": "HTTP"
    }
  ],
  "memories": [],
  "credentials": [],
  "evaluators": [],
  "onlineEvalConfigs": [],
  "agentCoreGateways": [],
  "policyEngines": []
}
```

### Project Fields

| Field               | Required | Description                                                 |
| ------------------- | -------- | ----------------------------------------------------------- |
| `name`              | Yes      | Project name (1-23 chars, alphanumeric, starts with letter) |
| `version`           | Yes      | Schema version (integer, currently `1`)                     |
| `tags`              | No       | Project-level tags applied to all resources                 |
| `runtimes`          | Yes      | Array of agent specifications                               |
| `memories`          | Yes      | Array of memory resources                                   |
| `credentials`       | Yes      | Array of credential providers (API key or OAuth)            |
| `evaluators`        | Yes      | Array of custom evaluator definitions                       |
| `onlineEvalConfigs` | Yes      | Array of online eval configurations                         |
| `policyEngines`     | No       | Array of policy engine configurations                       |
| `agentCoreGateways` | No       | Array of gateway definitions                                |
| `mcpRuntimeTools`   | No       | Array of MCP runtime tool definitions                       |
| `unassignedTargets` | No       | Targets not yet assigned to a gateway                       |

> Gateway configuration is in the `agentCoreGateways` field. See [Gateways and MCP Tools](#gateways-and-mcp-tools)
> below.

---

## Tags

AgentCore projects support config-driven tagging at both the project and resource levels. Tags flow through to the
deployed CloudFormation resources and help with resource organization, cost allocation, and automation.

### Project-Level Tags

Project-level tags are defined at the root of `agentcore.json` and are applied to all deployed resources. When you
initialize a new project, two default tags are automatically created:

- `agentcore:created-by` — set to `"agentcore-cli"`
- `agentcore:project-name` — set to your project name

You can add additional project-level tags by editing the `tags` field in `agentcore.json`:

```json
{
  "name": "MyProject",
  "version": 1,
  "tags": {
    "agentcore:created-by": "agentcore-cli",
    "agentcore:project-name": "MyProject",
    "Environment": "production",
    "Team": "platform",
    "CostCenter": "engineering"
  },
  "runtimes": [...],
  "memories": [...]
}
```

### Per-Resource Tags

Individual resources can define their own tags. When a resource-level tag uses the same key as a project-level tag, the
resource-level value takes precedence for that specific resource.

**Example:**

```json
{
  "name": "MyProject",
  "version": 1,
  "tags": {
    "Environment": "production",
    "Team": "platform"
  },
  "runtimes": [
    {
      "name": "MyAgent",
      "tags": {
        "Environment": "staging",
        "Owner": "alice"
      },
      ...
    }
  ]
}
```

In this example, `MyAgent` will have tags: `Environment: staging` (overrides project-level), `Team: platform` (inherited
from project), and `Owner: alice` (resource-specific).

### Taggable Resources

The following resource types support tags:

- **Agents** (`runtimes` array in `agentcore.json`)
- **Memories** (`memories` array in `agentcore.json`)
- **Gateways** (`agentCoreGateways` array in `agentcore.json`)
- **Evaluators** (`evaluators` array in `agentcore.json`)
- **Online Eval Configs** (`onlineEvalConfigs` array in `agentcore.json`)
- **Policy Engines** (`policyEngines` array in `agentcore.json`)

Resources that are **not** taggable include credentials, MCP runtime tools, unassigned targets, and policies.

### Tag Constraints

Tags must follow AWS tagging requirements:

- **Keys**: 1-128 characters, cannot start with `aws:`, allowed characters are Unicode letters, digits, whitespace, and
  `_.:/=+-@`
- **Values**: 0-256 characters, same allowed characters as keys
- **Maximum**: 50 tags per resource

### Managing Tags

Tags are managed by editing `agentcore.json` directly. There are no CLI commands for tag management. Changes take effect
on the next deployment.

---

## Agent Specification (AgentEnvSpec)

```json
{
  "name": "MyAgent",
  "build": "CodeZip",
  "entrypoint": "main.py",
  "codeLocation": "app/MyAgent/",
  "runtimeVersion": "PYTHON_3_14",
  "networkMode": "PUBLIC",
  "envVars": [{ "name": "MY_VAR", "value": "my-value" }],
  "instrumentation": {
    "enableOtel": true
  }
}
```

| Field                     | Required | Description                                                     |
| ------------------------- | -------- | --------------------------------------------------------------- |
| `name`                    | Yes      | Agent name (1-48 chars, alphanumeric + underscore)              |
| `build`                   | Yes      | `"CodeZip"` or `"Container"`                                    |
| `entrypoint`              | Yes      | Entry file (e.g., `main.py` or `main.py:handler`)               |
| `codeLocation`            | Yes      | Directory containing agent code                                 |
| `runtimeVersion`          | Yes      | Runtime version (see below)                                     |
| `networkMode`             | No       | `"PUBLIC"` (default) or `"VPC"`                                 |
| `networkConfig`           | No       | VPC configuration (subnets, security groups)                    |
| `protocol`                | No       | `"HTTP"` (default), `"MCP"`, or `"A2A"`                         |
| `envVars`                 | No       | Custom environment variables                                    |
| `instrumentation`         | No       | OpenTelemetry settings                                          |
| `authorizerType`          | No       | `"AWS_IAM"` or `"CUSTOM_JWT"`                                   |
| `authorizerConfiguration` | No       | JWT authorizer settings (for `CUSTOM_JWT`)                      |
| `requestHeaderAllowlist`  | No       | Headers to forward to the agent                                 |
| `lifecycleConfiguration`  | No       | Runtime session lifecycle settings (idle timeout, max lifetime) |
| `executionRoleArn`        | No       | ARN of an existing IAM execution role (skips CDK-managed role)  |
| `tags`                    | No       | Agent-level tags                                                |

### Runtime Versions

**Python:**

- `PYTHON_3_10`
- `PYTHON_3_11`
- `PYTHON_3_12`
- `PYTHON_3_13`
- `PYTHON_3_14`

**Node.js:**

- `NODE_18`
- `NODE_20`
- `NODE_22`

---

## Memory Resource

```json
{
  "name": "MyMemory",
  "eventExpiryDuration": 30,
  "strategies": [{ "type": "SEMANTIC" }, { "type": "SUMMARIZATION" }]
}
```

| Field                 | Required | Description                                                     |
| --------------------- | -------- | --------------------------------------------------------------- |
| `name`                | Yes      | Memory name (1-48 chars)                                        |
| `eventExpiryDuration` | Yes      | Days until events expire (7-365)                                |
| `strategies`          | Yes      | Array of memory strategies (can be empty for short-term memory) |

### Memory Strategies

| Strategy          | Description                                            |
| ----------------- | ------------------------------------------------------ |
| `SEMANTIC`        | Vector-based similarity search for relevant context    |
| `SUMMARIZATION`   | Compressed conversation history                        |
| `USER_PREFERENCE` | Store user-specific preferences and settings           |
| `EPISODIC`        | Capture and reflect on meaningful interaction episodes |

Strategy configuration:

```json
{
  "type": "SEMANTIC",
  "name": "custom_semantic",
  "description": "Custom semantic memory",
  "namespaces": ["/users/facts", "/users/preferences"]
}
```

---

## Credential Resource

### API Key Credential

```json
{
  "authorizerType": "ApiKeyCredentialProvider",
  "name": "OpenAI"
}
```

| Field            | Required | Description                         |
| ---------------- | -------- | ----------------------------------- |
| `authorizerType` | Yes      | Always `"ApiKeyCredentialProvider"` |
| `name`           | Yes      | Credential name (1-128 chars)       |

### OAuth Credential

```json
{
  "authorizerType": "OAuthCredentialProvider",
  "name": "MyOAuthProvider",
  "discoveryUrl": "https://idp.example.com/.well-known/openid-configuration",
  "scopes": ["read", "write"]
}
```

| Field            | Required | Description                                            |
| ---------------- | -------- | ------------------------------------------------------ |
| `authorizerType` | Yes      | Always `"OAuthCredentialProvider"`                     |
| `name`           | Yes      | Credential name (1-128 chars)                          |
| `discoveryUrl`   | Yes      | OIDC discovery URL (must be a valid URL)               |
| `scopes`         | No       | Array of OAuth scopes                                  |
| `vendor`         | No       | Credential provider vendor (default: `"CustomOauth2"`) |
| `managed`        | No       | Whether auto-created by the CLI (do not edit)          |
| `usage`          | No       | `"inbound"` or `"outbound"`                            |

The actual secrets (API keys, client IDs, client secrets) are stored in `.env.local` for local development and in
AgentCore Identity service for deployed environments.

---

## Evaluator Resource

See [Evaluations](evals.md) for the full guide.

```json
{
  "name": "ResponseQuality",
  "level": "SESSION",
  "description": "Evaluate response quality",
  "config": {
    "llmAsAJudge": {
      "model": "us.anthropic.claude-sonnet-4-5-20250514-v1:0",
      "instructions": "Evaluate the response quality. Context: {context}",
      "ratingScale": {
        "numerical": [
          { "value": 1, "label": "Poor", "definition": "Fails to meet expectations" },
          { "value": 5, "label": "Excellent", "definition": "Far exceeds expectations" }
        ]
      }
    }
  }
}
```

| Field         | Required | Description                                     |
| ------------- | -------- | ----------------------------------------------- |
| `name`        | Yes      | Evaluator name (1-48 chars, alphanumeric + `_`) |
| `level`       | Yes      | `"SESSION"`, `"TRACE"`, or `"TOOL_CALL"`        |
| `description` | No       | Evaluator description                           |
| `config`      | Yes      | LLM-as-a-Judge configuration (see below)        |

### LLM-as-a-Judge Config

| Field          | Required | Description                                            |
| -------------- | -------- | ------------------------------------------------------ |
| `model`        | Yes      | Bedrock model ID or cross-region inference profile     |
| `instructions` | Yes      | Evaluation prompt with placeholders (e.g. `{context}`) |
| `ratingScale`  | Yes      | Either `numerical` or `categorical` array (not both)   |

### Rating Scale

**Numerical** — scored values:

```json
{ "numerical": [{ "value": 1, "label": "Poor", "definition": "..." }, ...] }
```

**Categorical** — named labels:

```json
{ "categorical": [{ "label": "Pass", "definition": "..." }, ...] }
```

---

## Online Eval Config Resource

```json
{
  "name": "QualityMonitor",
  "agent": "MyAgent",
  "evaluators": ["ResponseQuality", "Builtin.Faithfulness"],
  "samplingRate": 10,
  "enableOnCreate": true
}
```

| Field            | Required | Description                                                  |
| ---------------- | -------- | ------------------------------------------------------------ |
| `name`           | Yes      | Config name (1-48 chars, alphanumeric + `_`)                 |
| `agent`          | Yes      | Agent name to monitor (must match a project agent)           |
| `evaluators`     | Yes      | Array of evaluator names, `Builtin.*` IDs, or evaluator ARNs |
| `samplingRate`   | Yes      | Percentage of requests to evaluate (0.01–100)                |
| `description`    | No       | Config description (max 200 chars)                           |
| `enableOnCreate` | No       | Enable evaluation on deploy (default: true)                  |

---

## Gateways and MCP Tools

Gateway and MCP tool configuration is part of `agentcore.json` (in the `agentCoreGateways`, `mcpRuntimeTools`, and
`unassignedTargets` fields).

```json
{
  "name": "MyProject",
  "version": 1,
  "runtimes": [...],
  "agentCoreGateways": [
    {
      "name": "MyGateway",
      "description": "My gateway",
      "authorizerType": "NONE",
      "targets": [
        {
          "name": "WeatherTools",
          "targetType": "mcpServer",
          "endpoint": "https://mcp.example.com/mcp"
        }
      ]
    }
  ]
}
```

### Gateway

| Field                     | Required | Description                                                  |
| ------------------------- | -------- | ------------------------------------------------------------ |
| `name`                    | Yes      | Gateway name (alphanumeric, hyphens, 1-100 chars)            |
| `description`             | No       | Gateway description                                          |
| `targets`                 | Yes      | Array of gateway targets                                     |
| `authorizerType`          | No       | `"NONE"` (default), `"AWS_IAM"`, or `"CUSTOM_JWT"`           |
| `authorizerConfiguration` | No       | Required when `authorizerType` is `"CUSTOM_JWT"` (see below) |

### CUSTOM_JWT Authorizer Configuration

```json
{
  "authorizerType": "CUSTOM_JWT",
  "authorizerConfiguration": {
    "customJwtAuthorizer": {
      "discoveryUrl": "https://idp.example.com/.well-known/openid-configuration",
      "allowedAudience": ["my-api"],
      "allowedClients": ["my-client-id"],
      "allowedScopes": ["read", "write"]
    }
  }
}
```

| Field             | Required | Description                                                            |
| ----------------- | -------- | ---------------------------------------------------------------------- |
| `discoveryUrl`    | Yes      | OIDC discovery URL (must end with `/.well-known/openid-configuration`) |
| `allowedAudience` | Cond.    | Array of allowed audience values                                       |
| `allowedClients`  | Cond.    | Array of allowed client IDs                                            |
| `allowedScopes`   | Cond.    | Array of allowed scopes                                                |
| `customClaims`    | Cond.    | Custom claims for JWT validation                                       |

> At least one of `allowedAudience`, `allowedClients`, `allowedScopes`, or `customClaims` must be provided.

### Gateway Target

A target is a backend tool exposed through a gateway. Targets can be external MCP server endpoints or compute-backed
implementations.

**External MCP server endpoint:**

```json
{
  "name": "WeatherTools",
  "targetType": "mcpServer",
  "endpoint": "https://mcp.example.com/mcp"
}
```

**External endpoint with outbound auth:**

```json
{
  "name": "SecureTools",
  "targetType": "mcpServer",
  "endpoint": "https://api.example.com/mcp",
  "outboundAuth": {
    "type": "OAUTH",
    "credentialName": "MyOAuthProvider",
    "scopes": ["tools:read"]
  }
}
```

| Field             | Required | Description                                                                                             |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `name`            | Yes      | Target name                                                                                             |
| `targetType`      | Yes      | `"mcpServer"`, `"lambda"`, `"openApiSchema"`, `"smithyModel"`, `"apiGateway"`, or `"lambdaFunctionArn"` |
| `endpoint`        | Cond.    | MCP server URL (required for external `mcpServer` targets)                                              |
| `compute`         | Cond.    | Compute configuration (required for `lambda` and scaffolded targets)                                    |
| `toolDefinitions` | Cond.    | Array of tool definitions (required for `lambda` targets)                                               |
| `outboundAuth`    | No       | Outbound authentication configuration                                                                   |

### Outbound Auth

| Field            | Required | Description                                          |
| ---------------- | -------- | ---------------------------------------------------- |
| `type`           | Yes      | `"OAUTH"`, `"API_KEY"`, or `"NONE"` (default)        |
| `credentialName` | Cond.    | Credential name (required when type is not `"NONE"`) |
| `scopes`         | No       | OAuth scopes (for `"OAUTH"` type)                    |

---

## aws-targets.json

Deployment target

```json
[
  {
    "name": "default",
    "description": "Production (us-west-2)",
    "account": "123456789012",
    "region": "us-west-2"
  }
]
```

| Field         | Required | Description                             |
| ------------- | -------- | --------------------------------------- |
| `name`        | Yes      | Target name (used with `--target` flag) |
| `description` | No       | Target description                      |
| `account`     | Yes      | AWS account ID (12 digits)              |
| `region`      | Yes      | AWS region                              |

### Supported Regions

See [AgentCore Regions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html) for the
current list.

---

## .env.local

Secrets for local development. This file is gitignored.

```bash
# API key credentials
AGENTCORE_CREDENTIAL_{projectName}OPENAI=sk-...
AGENTCORE_CREDENTIAL_{projectName}ANTHROPIC=sk-ant-...
AGENTCORE_CREDENTIAL_{projectName}GEMINI=...

# OAuth credentials
AGENTCORE_CREDENTIAL_{projectName}{credentialName}_CLIENT_ID=my-client-id
AGENTCORE_CREDENTIAL_{projectName}{credentialName}_CLIENT_SECRET=my-client-secret
```

Environment variable names should match the credential names in your configuration.
