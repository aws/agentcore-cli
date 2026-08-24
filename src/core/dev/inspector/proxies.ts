/**
 * Thin proxies to a locally running agent: POST /api/mcp (JSON-RPC forward)
 * and GET /api/a2a/agent-card. Ported from the reference mcp-proxy.ts /
 * a2a-proxy.ts. Both forward the client's abort signal so a disconnect cancels
 * the upstream request.
 */
import type { HttpRequest, HttpResponse } from "../../../io/httpServer";
import { apiError, asString, errorMessage, json, parseJsonBody } from "./respond";
import type { InspectorDeps } from "./types";

/** Cap the buffered MCP response so a runaway agent cannot exhaust memory. */
const MAX_MCP_RESPONSE_BYTES = 10 * 1024 * 1024;

/** POST /api/mcp — forward a JSON-RPC body to the agent's /mcp endpoint. */
export async function handleMcpProxy(
  deps: InspectorDeps,
  request: HttpRequest,
): Promise<HttpResponse> {
  const parsed = parseJsonBody(request.body);
  if (!parsed) return apiError(400, "Invalid JSON");
  const agentName = asString(parsed.agentName);
  if (!agentName) return apiError(400, "agentName is required");
  const body = parsed.body;
  if (!body || typeof body !== "object") return apiError(400, "body is required");
  const sessionId = asString(parsed.sessionId);

  const running = deps.supervisor.running(agentName);
  if (!running) return apiError(400, `Agent "${agentName}" is not running`);

  let mcpResponse: Response;
  try {
    mcpResponse = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
      method: "POST",
      // The response is buffered and returned as JSON below, so ask for JSON
      // only rather than advertising an event stream this proxy never streams.
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(sessionId !== undefined && { "mcp-session-id": sessionId }),
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (error) {
    return apiError(502, `Failed to connect to MCP agent: ${errorMessage(error)}`);
  }
  if (!mcpResponse.ok) return apiError(502, `MCP server returned status ${mcpResponse.status}`);

  const responseText = await readCapped(mcpResponse, MAX_MCP_RESPONSE_BYTES);
  if (responseText === undefined) return apiError(502, "MCP response exceeded the size limit");

  const responseSessionId = mcpResponse.headers.get("mcp-session-id") ?? undefined;
  let result: unknown;
  try {
    result = JSON.parse(responseText);
  } catch {
    result = responseText;
  }
  return json(200, { success: true, result, sessionId: responseSessionId });
}

/** GET /api/a2a/agent-card?agentName=xxx — fetch the running agent's A2A card. */
export async function handleA2aAgentCard(
  deps: InspectorDeps,
  url: URL,
  signal: AbortSignal,
): Promise<HttpResponse> {
  const agentName = url.searchParams.get("agentName") ?? undefined;
  if (!agentName) return apiError(400, "agentName query parameter is required");

  const running = deps.supervisor.running(agentName);
  if (!running) return apiError(400, `Agent "${agentName}" is not running`);

  try {
    const cardResponse = await fetch(`http://127.0.0.1:${running.port}/.well-known/agent.json`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!cardResponse.ok) {
      return apiError(502, `Agent card not available (${cardResponse.status})`);
    }
    const card: unknown = await cardResponse.json();
    return json(200, { success: true, card });
  } catch (error) {
    return apiError(502, `Failed to fetch agent card: ${errorMessage(error)}`);
  }
}

/** Read a response body as text, or undefined when it exceeds `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) return undefined;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
