# {{ name }}

An A2A (Agent-to-Agent) agent deployed on Amazon Bedrock AgentCore using the Strands SDK.

## Overview

This agent speaks the A2A protocol. Other agents discover it via its agent card at
`/.well-known/agent-card.json` and invoke it with JSON-RPC (`message/send`, `message/stream`)
at the server root, matching the AgentCore Runtime A2A service contract.

## Adding Tools

Define tools with the `@tool` decorator in `main.py` and add them to the `tools` list:

```python
@tool
def my_tool(param: str) -> str:
    """Description of what the tool does."""
    return f"Result: {param}"
```

## Developing locally

`agentcore project dev` starts the agent locally on `0.0.0.0:9000`. Fetch its agent card at
`http://127.0.0.1:9000/.well-known/agent-card.json` and send it messages by posting A2A
JSON-RPC to `http://127.0.0.1:9000/`.

## Deployment

`agentcore project deploy` deploys the agent into Amazon Bedrock AgentCore. Invoke it with the
AWS CLI (`bedrock-agentcore invoke-agent-runtime`) using an A2A JSON-RPC payload.
