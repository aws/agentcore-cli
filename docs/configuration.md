# Configuration Reference

AgentCore projects use JSON configuration files in the `agentcore/` directory.

## Files Overview

| File                  | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `agentcore.json`      | Project, agents, memories, credentials, evaluators, online evals |
| `mcp.json`            | Gateways, gateway targets, and MCP tools                         |
| `aws-targets.json`    | Deployment targets                                               |
| `deployed-state.json` | Runtime state (auto-managed, do not edit)                        |
| `.env.local`          | API keys for local development (gitignored)                      |

---

## agentcore.json

Main project configuration using a **flat resource model**. Agents, memories, and credentials are top-level arrays.

```json
{
  "name": "MyProject",
  "version": 1,
  "agents": [
    {
      "type": "AgentCoreRuntime",
      "name": "MyAgent",
      "build": "CodeZip",
      "entrypoint": "main.py",
      "codeLocation": "app/MyAgent/",
      "runtimeVersion": "PYTHON_3_12"
    }
  ],
  "memories": [
    {
      "type": "AgentCoreMemory",
      "name": "MyMemory",
      "eventExpiryDuration": 30,
      "strategies": [{ "type": "SEMANTIC" }]
    }
  ],
  "credentials": [
    {
      "type": "ApiKeyCredentialProvider",
      "name": "OpenAI"
    }
  ],
  "evaluators": [
    {
      "type": "CustomEvaluator",
      "name": "ResponseQuality",
      "level": "SESSION",
      "config": {
        "llmAsAJudge": {
          "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
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
  ],
  "onlineEvalConfigs": []
}
```

### Project Fields

| Field               | Required | Description                                                 |
| ------------------- | -------- | ----------------------------------------------------------- |
| `name`              | Yes      | Project name (1-23 chars, alphanumeric, starts with letter) |
| `version`           | Yes      | Schema version (integer, currently `1`)                     |
| `agents`            | Yes      | Array of agent specifications                               |
| `memories`          | Yes      | Array of memory resources                                   |
| `credentials`       | Yes      | Array of credential providers (API key or OAuth)            |
| `evaluators`        | Yes      | Array of custom evaluator definitions                       |
| `onlineEvalConfigs` | Yes      | Array of online eval configurations                         |

> Gateway configuration is stored separately in `mcp.json`. See [mcp.json](#mcpjson) below.

---

## Agent Specification (AgentEnvSpec)

```json
{
  "type": "AgentCoreRuntime",
  "name": "MyAgent",
  "build": "CodeZip",
  "entrypoint": "main.py",
  "codeLocation": "app/MyAgent/",
  "runtimeVersion": "PYTHON_3_12",
  "networkMode": "PUBLIC",
  "envVars": [{ "name": "MY_VAR", "value": "my-value" }],
  "instrumentation": {
    "enableOtel": true
  }
}
```

| Field             | Required | Description                                        |
| ----------------- | -------- | -------------------------------------------------- |
| `type`            | Yes      | Always `"AgentCoreRuntime"`                        |
| `name`            | Yes      | Agent name (1-48 chars, alphanumeric + underscore) |
| `build`           | Yes      | `"CodeZip"` or `"Container"`                       |
| `entrypoint`      | Yes      | Entry file (e.g., `main.py` or `main.py:handler`)  |
| `codeLocation`    | Yes      | Directory containing agent code                    |
| `runtimeVersion`  | Yes      | Runtime version (see below)                        |
| `networkMode`     | No       | `"PUBLIC"` (default) or `"PRIVATE"`                |
| `envVars`         | No       | Custom environment variables                       |
| `instrumentation` | No       | OpenTelemetry settings                             |

### Runtime Versions

**Python:**

- `PYTHON_3_10`
- `PYTHON_3_11`
- `PYTHON_3_12`
- `PYTHON_3_13`

---

## Memory Resource

```json
{
  "type": "AgentCoreMemory",
  "name": "MyMemory",
  "eventExpiryDuration": 30,
  "strategies": [{ "type": "SEMANTIC" }, { "type": "SUMMARIZATION" }]
}
```

| Field                 | Required | Description                             |
| --------------------- | -------- | --------------------------------------- |
| `type`                | Yes      | Always `"AgentCoreMemory"`              |
| `name`                | Yes      | Memory name (1-48 chars)                |
| `eventExpiryDuration` | Yes      | Days until events expire (7-365)        |
| `strategies`          | Yes      | Array of memory strategies (at least 1) |

### Memory Strategies

| Strategy          | Description                                         |
| ----------------- | --------------------------------------------------- |
| `SEMANTIC`        | Vector-based similarity search for relevant context |
| `SUMMARIZATION`   | Compressed conversation history                     |
| `USER_PREFERENCE` | Store user-specific preferences and settings        |

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
  "type": "ApiKeyCredentialProvider",
  "name": "OpenAI"
}
```

| Field  | Required | Description                         |
| ------ | -------- | ----------------------------------- |
| `type` | Yes      | Always `"ApiKeyCredentialProvider"` |
| `name` | Yes      | Credential name (3-255 chars)       |

### OAuth Credential

```json
{
  "type": "OAuthCredentialProvider",
  "name": "MyOAuthProvider",
  "discoveryUrl": "https://idp.example.com/.well-known/openid-configuration",
  "scopes": ["read", "write"]
}
```

| Field          | Required | Description                                            |
| -------------- | -------- | ------------------------------------------------------ |
| `type`         | Yes      | Always `"OAuthCredentialProvider"`                     |
| `name`         | Yes      | Credential name (3-255 chars)                          |
| `discoveryUrl` | Yes      | OIDC discovery URL (must be a valid URL)               |
| `scopes`       | No       | Array of OAuth scopes                                  |
| `vendor`       | No       | Credential provider vendor (default: `"CustomOauth2"`) |
| `managed`      | No       | Whether auto-created by the CLI (do not edit)          |
| `usage`        | No       | `"inbound"` or `"outbound"`                            |

The actual secrets (API keys, client IDs, client secrets) are stored in `.env.local` for local development and in
AgentCore Identity service for deployed environments.

---

## Evaluator Resource

See [Evaluations](evals.md) for the full guide.

```json
{
  "type": "CustomEvaluator",
  "name": "ResponseQuality",
  "level": "SESSION",
  "description": "Evaluate response quality",
  "config": {
    "llmAsAJudge": {
      "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
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
| `type`        | Yes      | Always `"CustomEvaluator"`                      |
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
  "type": "OnlineEvaluationConfig",
  "name": "QualityMonitor",
  "agent": "MyAgent",
  "evaluators": ["ResponseQuality", "Builtin.Faithfulness"],
  "samplingRate": 10,
  "enableOnCreate": true
}
```

| Field            | Required | Description                                                  |
| ---------------- | -------- | ------------------------------------------------------------ |
| `type`           | Yes      | Always `"OnlineEvaluationConfig"`                            |
| `name`           | Yes      | Config name (1-48 chars, alphanumeric + `_`)                 |
| `agent`          | Yes      | Agent name to monitor (must match a project agent)           |
| `evaluators`     | Yes      | Array of evaluator names, `Builtin.*` IDs, or evaluator ARNs |
| `samplingRate`   | Yes      | Percentage of requests to evaluate (0.01–100)                |
| `description`    | No       | Config description (max 200 chars)                           |
| `enableOnCreate` | No       | Enable evaluation on deploy (default: true)                  |

---

## mcp.json

Gateway and MCP tool configuration. Gateways, their targets, and standalone MCP runtime tools are defined here.

```json
{
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
  ],
  "unassignedTargets": []
}
```

### Top-Level Fields

| Field               | Required | Description                           |
| ------------------- | -------- | ------------------------------------- |
| `agentCoreGateways` | Yes      | Array of gateway definitions          |
| `unassignedTargets` | No       | Targets not yet assigned to a gateway |

### Gateway

| Field                     | Required | Description                                                  |
| ------------------------- | -------- | ------------------------------------------------------------ |
| `name`                    | Yes      | Gateway name (alphanumeric, hyphens, 1-63 chars)             |
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
| `allowedAudience` | Yes      | Array of allowed audience values                                       |
| `allowedClients`  | Yes      | Array of allowed client IDs (at least 1)                               |
| `allowedScopes`   | No       | Array of allowed scopes                                                |

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

| Field             | Required | Description                                                          |
| ----------------- | -------- | -------------------------------------------------------------------- |
| `name`            | Yes      | Target name                                                          |
| `targetType`      | Yes      | `"mcpServer"` or `"lambda"`                                          |
| `endpoint`        | Cond.    | MCP server URL (required for external `mcpServer` targets)           |
| `compute`         | Cond.    | Compute configuration (required for `lambda` and scaffolded targets) |
| `toolDefinitions` | Cond.    | Array of tool definitions (required for `lambda` targets)            |
| `outboundAuth`    | No       | Outbound authentication configuration                                |

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
