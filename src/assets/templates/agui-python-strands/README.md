# {{ name }}

An AG-UI agent deployed on Amazon Bedrock AgentCore using the Strands SDK.

## Overview

This agent speaks the [AG-UI protocol](https://docs.ag-ui.com/introduction), which
streams agent-to-UI events over HTTP. It exposes an `/invocations` endpoint that accepts
an AG-UI `RunAgentInput` body and streams the response back as AG-UI server-sent events,
matching the AgentCore Runtime HTTP service contract.

## Adding Tools

Define tools with the `@tool` decorator in `main.py` and add them to the agent's `tools` list:

```python
@tool
def my_tool(param: str) -> str:
    """Description of what the tool does."""
    return f"Result: {param}"
```

## Developing locally

`agentcore dev` starts the agent locally on `0.0.0.0:8080`. Post an AG-UI
`RunAgentInput` body to `http://127.0.0.1:8080/invocations` to invoke it, and check its
health at `http://127.0.0.1:8080/ping`.

## Deployment

`agentcore deploy` deploys the agent into Amazon Bedrock AgentCore. Invoke the deployed
runtime with an AG-UI `RunAgentInput` payload:

```bash
agentcore invoke --runtime {{ name }} \
  --payload '{"threadId":"t1","runId":"r1","state":{},"messages":[{"id":"m1","role":"user","content":"Hello!"}],"tools":[],"context":[],"forwardedProps":{}}'
```

The response streams back as AG-UI server-sent events.
