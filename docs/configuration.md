# Configuration Reference

AgentCore projects use JSON configuration files in the `agentcore/` directory.

## Files Overview

| File                  | Purpose                                     |
| --------------------- | ------------------------------------------- |
| `agentcore.json`      | Project, agents, memories, and credentials  |
| `aws-targets.json`    | Deployment targets                          |
| `deployed-state.json` | Runtime state (auto-managed, do not edit)   |
| `.env.local`          | API keys for local development (gitignored) |

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
  ]
}
```

### Project Fields

| Field         | Required | Description                                                 |
| ------------- | -------- | ----------------------------------------------------------- |
| `name`        | Yes      | Project name (1-23 chars, alphanumeric, starts with letter) |
| `version`     | Yes      | Schema version (integer, currently `1`)                     |
| `agents`      | Yes      | Array of agent specifications                               |
| `memories`    | Yes      | Array of memory resources                                   |
| `credentials` | Yes      | Array of credential providers                               |

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

**Node.js:**

- `NODE_18`
- `NODE_20`
- `NODE_22`

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
| `CUSTOM`          | Custom strategy implementation                      |

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

The actual API key is stored in `.env.local` for local development and in AWS Secrets Manager for deployed environments.

---

## aws-targets.json

Array of deployment targets.

```json
[
  {
    "name": "default",
    "description": "Production (us-west-2)",
    "account": "123456789012",
    "region": "us-west-2"
  },
  {
    "name": "dev",
    "description": "Development (us-east-1)",
    "account": "123456789012",
    "region": "us-east-1"
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

API keys for local development. This file is gitignored.

```bash
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_API_KEY=AI...
```

Environment variable names should match the credential names in your configuration.
