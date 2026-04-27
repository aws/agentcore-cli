# Web UI (Browser Mode)

Browser mode (`agentcore dev`) launches a local proxy server that serves both the chat UI and API endpoints.

## Architecture

```
Browser → http://127.0.0.1:8081
        |
  Node.js Server  (port: findAvailablePort(8081))
   ├─ Serves frontend (static files from built agent-inspector)
   └─ API endpoints (/api/status, /invocations, etc.)
        |
        | HTTP (deterministic port: proxyPort + 1 + agentIndex)
        v
  Python Agent Server  (uvicorn or Docker)
```

Two processes are always involved:

- The **server** is a Node.js HTTP server. It serves the frontend, handles agent selection API calls, and forwards
  invocations to the correct Python agent.
- The **agent server** is a Python process (uvicorn for CodeZip, Docker for Container). It is started on demand when the
  frontend selects an agent.

## Port Assignment

| Process | Port                                                        |
| ------- | ----------------------------------------------------------- |
| Server  | `findAvailablePort(8081)` — tries 8081, increments if taken |
| Agent 0 | `proxyPort + 1`                                             |
| Agent 1 | `proxyPort + 2`                                             |
| Agent N | `proxyPort + 1 + N`                                         |

Ports are deterministic relative to the proxy port, so no scanning is needed for agents.

## Frontend

The chat UI lives in the `@aws/agent-inspector` package. At build time, it produces static files (index.html, index.js,
index.css) that are copied to `dist/agent-inspector/`. The Node.js server serves these files for any non-API GET
request, with SPA fallback to `index.html`.

### Frontend Development (Hot Reload)

For frontend development with hot module replacement:

1. Terminal 1: `agentcore dev` (starts the API server)
2. Terminal 2: `npm run dev:ui` (starts Vite dev server on localhost:5173)
3. Open `http://localhost:5173?port=8081` in your browser

The `?port=` query param tells the frontend to connect to the CLI's API server. The CLI allows `localhost:5173` in its
CORS allowlist for this workflow.

## API Endpoints

All endpoints are served by the Node.js server. Types are defined in `api-types.ts` and exported from the package so the
frontend can import them:

```ts
import type { ResourceDeploymentStatus, ResourcesResponse, StatusAgentError, StatusResponse } from '@aws/agentcore';
```

### `GET /api/status`

Returns available agents, which ones are currently running, and any per-agent errors (e.g. failed to start, server
crashed).

```json
{
  "agents": [{ "name": "MyAgent", "buildType": "CodeZip" }],
  "running": [{ "name": "MyAgent", "port": 8082 }],
  "errors": []
}
```

When an agent fails to start (e.g. Docker not ready, missing Dockerfile, server crash), the `errors` array includes the
agent name and error message:

```json
{
  "agents": [{ "name": "MyAgent", "buildType": "Container" }],
  "running": [],
  "errors": [
    {
      "name": "MyAgent",
      "message": "Found docker, podman, finch but not ready. Start a runtime:\ndocker: Start Docker Desktop or run: sudo systemctl start docker"
    }
  ]
}
```

Errors are cleared when the agent is successfully started again via `POST /api/start`.

The agent list is kept in sync with `agentcore.json` via `fs.watch` — if you add or remove an agent in another terminal,
the status endpoint reflects the change without restarting the dev server.

### `GET /api/resources`

Returns the full project resource graph by reading config files (`agentcore.json`, `mcp.json`, `deployed-state.json`) on
each call (always fresh).

Each resource includes an optional `deploymentStatus` field computed by diffing local config against the deployed state
file (same logic as `agentcore status`). Possible values:

- `"deployed"` — exists both locally and in AWS
- `"local-only"` — exists in config but hasn't been deployed yet
- `"pending-removal"` — removed from local config but still exists in AWS

The field is `undefined` when no deployed state file exists (project has never been deployed).

```json
{
  "success": true,
  "project": "MyProject",
  "agents": [
    {
      "name": "MyAgent",
      "build": "CodeZip",
      "entrypoint": "main.py:handler",
      "codeLocation": "app/MyAgent",
      "runtimeVersion": "PYTHON_3_13",
      "networkMode": "PUBLIC",
      "envVars": ["OPENAI_API_KEY"],
      "deploymentStatus": "deployed"
    }
  ],
  "memories": [
    {
      "name": "MyMemory",
      "strategies": [{ "type": "SEMANTIC", "namespaces": [] }],
      "expiryDays": 30,
      "deploymentStatus": "local-only"
    }
  ],
  "credentials": [{ "name": "anthropic-key", "type": "ApiKeyCredentialProvider", "deploymentStatus": "deployed" }],
  "gateways": [
    {
      "name": "my-gateway",
      "targets": [{ "name": "my-tool", "targetType": "lambda" }],
      "deploymentStatus": "local-only"
    }
  ],
  "mcpRuntimeTools": [{ "name": "my-mcp-tool", "bindings": [{ "agentName": "MyAgent", "envVarName": "MCP_TOOL_ARN" }] }]
}
```

### `POST /api/start`

Starts an agent server on demand. If already running, returns the existing port.

Request:

```json
{ "agentName": "MyAgent" }
```

Response:

```json
{ "success": true, "name": "MyAgent", "port": 8082 }
```

Error:

```json
{ "success": false, "error": "Agent \"MyAgent\" not found or not supported" }
```

### `POST /invocations`

Proxies a chat invocation to the selected running agent. The `agentName` field routes to the correct agent; falls back
to the first running agent if omitted.

Request:

```json
{ "agentName": "MyAgent", "prompt": "Hello", "sessionId": "abc", "userId": "user1" }
```

### `GET /api/traces?agentName=xxx[&startTime=ms&endTime=ms]`

Lists recent traces for an agent. Available when the OTEL collector is active.

Query parameters:

- `agentName` (required) — agent to query traces for
- `startTime` (optional) — start of the time range in epoch milliseconds. Defaults to 12 hours before `endTime`.
- `endTime` (optional) — end of the time range in epoch milliseconds. Defaults to now.

Response:

```json
{ "success": true, "traces": [...] }
```

### `GET /api/traces/:traceId?agentName=xxx[&startTime=ms&endTime=ms]`

Returns full trace data (spans) for a specific trace. Available when the OTEL collector is active.

Query parameters:

- `agentName` (required) — agent the trace belongs to
- `startTime` (optional) — start of the time range in epoch milliseconds. Defaults to 12 hours before `endTime`.
- `endTime` (optional) — end of the time range in epoch milliseconds. Defaults to now.

Response:

```json
{ "success": true, "spans": [...] }
```

### `GET /api/memory?memoryName=xxx&namespace=yyy[&strategyId=zzz]`

Lists memory records for a given memory and namespace. Requires a deployed memory with `onListMemoryRecords` handler.

Response:

```json
{ "success": true, "records": [...], "nextToken": "..." }
```

### `POST /api/memory/search`

Performs semantic search across memory records. Requires a deployed memory with `onRetrieveMemoryRecords` handler.

Request:

```json
{ "memoryName": "MyMemory", "namespace": "/users/123/facts", "searchQuery": "preferences", "strategyId": "optional" }
```

Response:

```json
{ "success": true, "records": [...] }
```
