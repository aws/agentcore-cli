# MCP Tools

MCP (Model Context Protocol) tools extend agent capabilities. AgentCore supports two deployment modes.

## Deployment Modes

| Mode               | Description                     | Use Case                               |
| ------------------ | ------------------------------- | -------------------------------------- |
| **MCP Runtime**    | Direct agent-to-tool connection | Simple setups, single agent            |
| **Behind Gateway** | Tools exposed via HTTP gateway  | Shared tools, JWT auth, Lambda hosting |

## MCP Runtime Tools

Deploy tools as AgentCore Runtimes bound directly to agents.

```bash
agentcore-cli add mcp-tool --exposure mcp-runtime
```

### mcp.json Configuration

```json
{
  "agentCoreGateways": [],
  "mcpRuntimeTools": [
    {
      "name": "MyTool",
      "toolDefinition": {
        "name": "MyTool",
        "description": "Tool description",
        "inputSchema": { "type": "object" }
      },
      "compute": {
        "host": "AgentCoreRuntime",
        "implementation": {
          "language": "Python",
          "path": "app/mcp/MyTool",
          "handler": "server.py:main"
        },
        "runtime": {
          "artifact": "CodeZip",
          "pythonVersion": "PYTHON_3_12",
          "name": "MyTool",
          "entrypoint": "server.py:main",
          "codeLocation": "app/mcp/MyTool",
          "networkMode": "PUBLIC"
        }
      }
    }
  ]
}
```

### Binding to Agents

After creating an MCP runtime tool, attach it to agents:

```bash
agentcore-cli attach mcp-runtime --agent MyAgent --runtime MyTool
```

This adds a reference in `agentcore.json`:

```json
{
  "remoteTools": [
    {
      "type": "AgentCoreMcpRuntime",
      "mcpRuntimeName": "MyTool",
      "envVarName": "AGENTCORE_MCPRUNTIME_MYTOOL_URL",
      "name": "MyToolRef",
      "description": "MCP runtime reference"
    }
  ]
}
```

---

## Gateway Tools

Deploy tools behind an MCP Gateway with optional JWT authorization.

```bash
agentcore-cli add gateway
agentcore-cli add mcp-tool --exposure behind-gateway
```

### Gateway Configuration

```json
{
  "agentCoreGateways": [
    {
      "name": "main-gateway",
      "description": "Primary tool gateway",
      "authorizerType": "NONE",
      "targets": [
        {
          "name": "MyTarget",
          "targetType": "lambda",
          "toolDefinitions": [
            {
              "name": "lookup_ip",
              "description": "Look up IP geolocation",
              "inputSchema": {
                "type": "object",
                "properties": {
                  "ip_address": { "type": "string" }
                },
                "required": ["ip_address"]
              }
            }
          ],
          "compute": {
            "host": "Lambda",
            "implementation": {
              "language": "Python",
              "path": "app/mcp/tools",
              "handler": "handler.lambda_handler"
            },
            "pythonVersion": "PYTHON_3_12"
          }
        }
      ]
    }
  ]
}
```

### Compute Hosts

| Host               | Languages          | Notes                      |
| ------------------ | ------------------ | -------------------------- |
| `Lambda`           | Python, TypeScript | Serverless, scales to zero |
| `AgentCoreRuntime` | Python only        | Always-on, lower latency   |

### JWT Authorization

For authenticated gateways:

```json
{
  "name": "secure-gateway",
  "authorizerType": "CUSTOM_JWT",
  "authorizerConfiguration": {
    "customJwtAuthorizer": {
      "discoveryUrl": "https://cognito-idp.us-west-2.amazonaws.com/us-west-2_xxx/.well-known/openid-configuration",
      "allowedAudience": ["client-id-1"],
      "allowedClients": ["client-id-1"]
    }
  },
  "targets": [...]
}
```

| Field             | Description                                                                 |
| ----------------- | --------------------------------------------------------------------------- |
| `discoveryUrl`    | OIDC discovery endpoint (must end with `/.well-known/openid-configuration`) |
| `allowedAudience` | Valid JWT audience values                                                   |
| `allowedClients`  | Valid JWT client IDs                                                        |

### Attaching Gateway to Agent

```bash
agentcore-cli attach gateway --agent MyAgent --gateway main-gateway
```

This adds an MCP provider in `agentcore.json`:

```json
{
  "mcpProviders": [
    {
      "type": "AgentCoreGateway",
      "name": "MainTools",
      "description": "Primary tool gateway",
      "gatewayName": "main-gateway",
      "envVarName": "AGENTCORE_GATEWAY_MAIN"
    }
  ]
}
```

---

## Tool Definition Schema

Both modes use the same tool definition format:

```json
{
  "name": "tool_name",
  "description": "What the tool does",
  "inputSchema": {
    "type": "object",
    "properties": {
      "param1": { "type": "string", "description": "Parameter description" },
      "param2": { "type": "integer" }
    },
    "required": ["param1"]
  }
}
```

---

## When to Use Each Mode

**Use MCP Runtime when:**

- Single agent needs the tool
- Low latency is important
- Simple setup preferred

**Use Gateway when:**

- Multiple agents share tools
- JWT authentication required
- Want Lambda's scale-to-zero
- TypeScript tools needed
