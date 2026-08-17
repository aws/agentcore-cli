/**
 * Thin proxies to a locally running agent: POST /api/mcp (JSON-RPC forward)
 * and GET /api/a2a/agent-card. Ported from the reference mcp-proxy.ts /
 * a2a-proxy.ts.
 */
import type { HttpRequest, HttpResponse } from "../../../io/httpServer";
import { asString } from "./invocations";
import { apiError, errorMessage, json, parseJsonBody } from "./respond";
import type { InspectorDeps } from "./types";

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
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sessionId !== undefined && { "mcp-session-id": sessionId }),
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return apiError(502, `Failed to connect to MCP agent: ${errorMessage(error)}`);
  }
  if (!mcpResponse.ok) return apiError(502, `MCP server returned status ${mcpResponse.status}`);

  const responseText = await mcpResponse.text();
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
export async function handleA2aAgentCard(deps: InspectorDeps, url: URL): Promise<HttpResponse> {
  const agentName = url.searchParams.get("agentName") ?? undefined;
  if (!agentName) return apiError(400, "agentName query parameter is required");

  const running = deps.supervisor.running(agentName);
  if (!running) return apiError(400, `Agent "${agentName}" is not running`);

  try {
    const cardResponse = await fetch(`http://127.0.0.1:${running.port}/.well-known/agent.json`, {
      method: "GET",
      headers: { Accept: "application/json" },
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
