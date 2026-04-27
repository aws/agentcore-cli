import type { RouteContext } from './route-context.js';
import type { IncomingMessage, ServerResponse } from 'http';

export async function handleMcpProxy(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  origin?: string
): Promise<void> {
  ctx.setCorsHeaders(res, origin);

  const raw = await ctx.readBody(req);
  let parsed: { agentName?: string; body?: Record<string, unknown>; sessionId?: string };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
    return;
  }

  const { agentName, body, sessionId } = parsed;

  if (!agentName) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'agentName is required' }));
    return;
  }

  if (!body) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'body is required' }));
    return;
  }

  const running = ctx.runningAgents.get(agentName);
  if (!running) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: `Agent "${agentName}" is not running` }));
    return;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  let mcpRes: Response;
  try {
    mcpRes = await fetch(`http://localhost:${running.port}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: `Failed to connect to MCP agent: ${(err as Error).message}` }));
    return;
  }

  if (!mcpRes.ok) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: `MCP server returned status ${mcpRes.status}` }));
    return;
  }

  const responseText = await mcpRes.text();
  const responseSessionId = mcpRes.headers.get('mcp-session-id') ?? undefined;

  let result: unknown;
  try {
    result = JSON.parse(responseText);
  } catch {
    result = responseText;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ success: true, result, sessionId: responseSessionId }));
}
