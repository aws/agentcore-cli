# Configuration Reference

AgentCore projects use JSON configuration files in the `agentcore/` directory.

## Files Overview

| File                  | Purpose                                     |
| --------------------- | ------------------------------------------- |
| `agentcore.json`      | Project and agent definitions               |
| `aws-targets.json`    | Deployment targets                          |
| `mcp.json`            | MCP runtime tools                           |
| `deployed-state.json` | Runtime state (auto-managed, do not edit)   |
| `.env.local`          | API keys for local development (gitignored) |

---

## agentcore.json

Main project configuration containing agents and their capabilities.

```json
{
  "name": "MyProject",
  "version": "0.1",
  "description": "Project description",
  "agents": [...]
}
```

### Project Fields

| Field               | Required | Description                                                 |
| ------------------- | -------- | ----------------------------------------------------------- |
| `name`              | Yes      | Project name (1-23 chars, alphanumeric, starts with letter) |
| `version`           | Yes      | Schema version (currently `"0.1"`)                          |
| `description`       | Yes      | Project description                                         |
| `agents`            | Yes      | Array of agent specifications                               |
| `identityKmsKeyArn` | No       | KMS key ARN for encrypting identity credentials             |

### Agent Specification

```json
{
  "name": "MyAgent",
  "id": "my-agent-001",
  "sdkFramework": "Strands",
  "targetLanguage": "Python",
  "modelProvider": "Bedrock",
  "runtime": {...},
  "mcpProviders": [],
  "memoryProviders": [],
  "identityProviders": [],
  "remoteTools": []
}
```

| Field               | Required | Description                                                              |
| ------------------- | -------- | ------------------------------------------------------------------------ |
| `name`              | Yes      | Agent name (1-64 chars, alphanumeric)                                    |
| `id`                | Yes      | Unique identifier                                                        |
| `sdkFramework`      | Yes      | `Strands`, `LangChain_LangGraph`, `AutoGen`, `GoogleADK`, `OpenAIAgents` |
| `targetLanguage`    | Yes      | `Python` or `TypeScript`                                                 |
| `modelProvider`     | Yes      | `Bedrock`, `Anthropic`, `OpenAI`, `Gemini`                               |
| `runtime`           | Yes      | Runtime configuration                                                    |
| `memoryProviders`   | Yes      | Memory configurations                                                    |
| `identityProviders` | Yes      | Identity/API key configurations                                          |
| `remoteTools`       | Yes      | Agent-to-agent references                                                |

### Runtime Configuration

```json
{
  "artifact": "CodeZip",
  "name": "MyAgentRuntime",
  "pythonVersion": "PYTHON_3_12",
  "entrypoint": "main.py",
  "codeLocation": "app/MyAgent/",
  "networkMode": "PUBLIC"
}
```

| Field           | Required | Description                                    |
| --------------- | -------- | ---------------------------------------------- |
| `artifact`      | Yes      | Always `"CodeZip"`                             |
| `name`          | Yes      | Runtime name (1-23 chars)                      |
| `pythonVersion` | Yes      | `PYTHON_3_12` or `PYTHON_3_13`                 |
| `entrypoint`    | Yes      | Python file (e.g., `main.py` or `main.py:app`) |
| `codeLocation`  | Yes      | Directory containing agent code                |
| `networkMode`   | No       | `PUBLIC` (default) or `PRIVATE`                |

### Memory Provider

Owned memory (agent creates and manages):

```json
{
  "type": "AgentCoreMemory",
  "relation": "own",
  "name": "MyMemory",
  "description": "Agent memory",
  "envVarName": "AGENTCORE_MEMORY_MYMEMORY",
  "config": {
    "eventExpiryDuration": 30,
    "memoryStrategies": [{ "type": "SEMANTIC" }, { "type": "SUMMARIZATION" }]
  }
}
```

Referenced memory (agent uses another agent's memory):

```json
{
  "type": "AgentCoreMemory",
  "relation": "use",
  "name": "SharedMemory",
  "description": "Reference to shared memory",
  "envVarName": "AGENTCORE_MEMORY_SHARED",
  "access": "readwrite"
}
```

| Field        | Required | Description                               |
| ------------ | -------- | ----------------------------------------- |
| `type`       | Yes      | Always `"AgentCoreMemory"`                |
| `relation`   | Yes      | `"own"` (creates) or `"use"` (references) |
| `name`       | Yes      | Memory name                               |
| `envVarName` | Yes      | Environment variable for memory ID        |
| `config`     | Own only | Memory configuration                      |
| `access`     | Use only | `"read"` or `"readwrite"`                 |

### Identity Provider

```json
{
  "type": "AgentCoreIdentity",
  "variant": "ApiKeyCredentialProvider",
  "relation": "own",
  "name": "OpenAI",
  "description": "OpenAI API key",
  "envVarName": "AGENTCORE_IDENTITY_OPENAI"
}
```

| Field        | Required | Description                         |
| ------------ | -------- | ----------------------------------- |
| `type`       | Yes      | Always `"AgentCoreIdentity"`        |
| `variant`    | Yes      | Always `"ApiKeyCredentialProvider"` |
| `relation`   | Yes      | `"own"` or `"use"`                  |
| `name`       | Yes      | Identity name                       |
| `envVarName` | Yes      | Environment variable for API key    |

### Remote Tools

Agent-to-agent invocation:

```json
{
  "type": "AgentCoreAgentInvocation",
  "name": "CallHelper",
  "description": "Invoke helper agent",
  "targetAgentName": "HelperAgent",
  "envVarName": "AGENTCORE_AGENT_HELPER_ARN"
}
```

MCP runtime reference:

```json
{
  "type": "AgentCoreMcpRuntime",
  "name": "MyMcpTool",
  "description": "MCP runtime tool",
  "mcpRuntimeName": "DirectTool",
  "envVarName": "AGENTCORE_MCPRUNTIME_DIRECTTOOL_URL"
}
```

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
AGENTCORE_IDENTITY_OPENAI=sk-...
AGENTCORE_IDENTITY_ANTHROPIC=sk-ant-...
AGENTCORE_IDENTITY_GEMINI=AI...
```

The environment variable names must match the `envVarName` in your identity providers.
