# MCP Tools

MCP (Model Context Protocol) tools extend agent capabilities.

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

## Tool Definition Schema

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
