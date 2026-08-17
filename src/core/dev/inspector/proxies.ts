/**
 * Thin proxies to a locally running agent: POST /api/mcp (JSON-RPC forward,
 * with a deployed variant behind the injected AWS capability) and
 * GET /api/a2a/agent-card. Ported from the reference mcp-proxy.ts / a2a-proxy.ts.
 */
import type { HttpRequest, HttpResponse } from "../../../io/httpServer";
import { asString } from "./invocations";
import { apiError, errorMessage, json, parseJsonBody } from "./respond";
import type { InspectorDeps } from "./types";

/** POST /api/mcp — forward a JSON-RPC body to the agent's /mcp endpoint. */
export async function handleMcpProxy(
  deps: InspectorDeps,
  request: HttpRequest,
  url: URL,
): Promise<HttpResponse> {
  if (url.searchParams.get("target") === "deployed") return handleDeployedMcp(deps, request);

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

/** POST /api/mcp?target=deployed — MCP JSON-RPC against a deployed runtime. */
async function handleDeployedMcp(deps: InspectorDeps, request: HttpRequest): Promise<HttpResponse> {
  const mcp = deps.aws?.mcp;
  if (!mcp) return apiError(404, "Deployed MCP is not available");

  const parsed = parseJsonBody(request.body);
  if (!parsed) return apiError(400, "Invalid JSON");
  const body = parsed.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") return apiError(400, "body is required");

  const target = {
    agentName: asString(parsed.agentName),
    targetName: asString(parsed.targetName),
    sessionId: asString(parsed.sessionId),
  };
  const method = asString(body.method);

  try {
    if (method === "initialize") {
      const { sessionId } = await mcp.initialize(target);
      return json(200, { success: true, result: { jsonrpc: "2.0", result: {} }, sessionId });
    }
    if (method === "tools/list") {
      const { tools } = await mcp.listTools(target);
      return json(200, { success: true, result: { jsonrpc: "2.0", result: { tools } } });
    }
    if (method === "tools/call") {
      const params = body.params as
        { name?: string; arguments?: Record<string, unknown> } | undefined;
      if (!params?.name) return apiError(400, "tools/call requires params.name");
      const response = await mcp.callTool({
        ...target,
        name: params.name,
        arguments: params.arguments ?? {},
      });
      return json(200, {
        success: true,
        result: { jsonrpc: "2.0", result: { content: [{ type: "text", text: response }] } },
      });
    }
    return apiError(400, `Unsupported MCP method: ${method}`);
  } catch (error) {
    return apiError(502, `MCP invoke failed: ${errorMessage(error)}`);
  }
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
