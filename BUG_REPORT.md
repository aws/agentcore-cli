# Bug: `agentcore invoke` fails with "Not a WebSocket Upgrade Request" for HTTP-protocol runtimes

## Problem

`agentcore invoke` (v0.9.1) fails for all HTTP-protocol runtimes with:

```
Unexpected token 'N', "Not a WebS"... is not valid JSON
  Deserialization error: to see the raw response, inspect the hidden field {error}.$response on this object.
```

The root cause is in `src/cli/aws/agentcore.ts`. The `invokeAgentRuntime` and `invokeAgentRuntimeStreaming` functions use the `InvokeAgentRuntimeCommand` from `@aws-sdk/client-bedrock-agentcore`, which sends a standard HTTP POST to the `/runtimes/{arn}/invocations` endpoint. However, the AgentCore service **only accepts WebSocket upgrade requests** on this endpoint — it rejects plain HTTP with `"Not a WebSocket Upgrade Request"`.

The CLI then tries to JSON-parse that error string, which fails with the deserialization error above.

## Reproduction

1. Create any AgentCore project with `protocol: "HTTP"` in `agentcore.json`
2. Deploy: `agentcore deploy --target default`
3. Wait for runtime to be READY: `agentcore status`
4. Invoke: `agentcore invoke --prompt "hello" --json`
5. Observe the error

The runtime container is healthy (`/ping` returns 200 in logs), but the CLI never reaches it.

## Evidence

Container logs show the agent is running and responding to health checks:
```
INFO: 127.0.0.1:41060 - "GET /ping HTTP/1.1" 200 OK
```

But no invocation requests ever arrive at the container. The error occurs at the AgentCore service proxy level.

## Workaround

Using the Python SDK's `generate_presigned_url()` with a WebSocket client works:

```python
from bedrock_agentcore.runtime import AgentCoreRuntimeClient
import websockets, asyncio, json

client = AgentCoreRuntimeClient(region="us-east-1")
url = client.generate_presigned_url(runtime_arn="arn:aws:bedrock-agentcore:...")

async def invoke():
    async with websockets.connect(url) as ws:
        await ws.send(json.dumps({"prompt": "hello"}))
        return await asyncio.wait_for(ws.recv(), timeout=120)

print(asyncio.run(invoke()))
```

## Suggested Fix

The `invokeAgentRuntime` / `invokeAgentRuntimeStreaming` functions in `src/cli/aws/agentcore.ts` need to use a WebSocket connection (with SigV4 presigned URL) instead of the SDK's `InvokeAgentRuntimeCommand` HTTP POST. The Python SDK (`bedrock-agentcore`) already does this correctly via `AgentCoreRuntimeClient.generate_presigned_url()`.

The bearer-token code path (`invokeWithBearerToken`) has the same issue — it uses `fetch()` HTTP POST against the same endpoint.

## Additional Context

- **CLI version**: 0.9.1 (latest as of 2026-04-21)
- **Runtime protocol**: HTTP
- **Region**: us-east-1
- **`@aws-sdk/client-bedrock-agentcore`**: The `InvokeAgentRuntimeCommand` itself may need to be updated to use WebSocket transport, or the CLI should bypass the SDK command and use presigned WebSocket URLs directly.

## Impact

`agentcore invoke` is completely non-functional for HTTP-protocol runtimes. This affects all users deploying agents with `BedrockAgentCoreApp` or plain FastAPI/uvicorn containers.
