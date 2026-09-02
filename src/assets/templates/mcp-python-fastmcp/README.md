# {{ name }}

An MCP (Model Context Protocol) server deployed on Amazon Bedrock AgentCore.

## Overview

This project implements an MCP server using FastMCP. MCP servers expose tools that can be
consumed by MCP clients (other agents or applications). The server speaks Streamable HTTP
transport at `/mcp`, matching the AgentCore Runtime MCP service contract.

## Adding Tools

Define tools using the `@mcp.tool()` decorator in `main.py`:

```python
@mcp.tool()
def my_tool(param: str) -> str:
    """Description of what the tool does."""
    return f"Result: {param}"
```

## Developing locally

If installation was successful, a virtual environment is already created with dependencies installed.

`agentcore project dev` starts the server locally on `0.0.0.0:8000`. List and call tools by
sending JSON-RPC to `http://127.0.0.1:8000/mcp`.

## Deployment

`agentcore project deploy` deploys the server into Amazon Bedrock AgentCore. Invoke it with
`agentcore project invoke runtime`, supplying an MCP JSON-RPC payload (e.g. `tools/list`, `tools/call`).
