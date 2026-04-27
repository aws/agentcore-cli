import { type RouteContext, parseRequestUrl } from './route-context';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** GET /api/a2a/agent-card?agentName=xxx — fetch A2A agent card from the running agent */
export async function handleA2AAgentCard(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  origin?: string
): Promise<void> {
  ctx.setCorsHeaders(res, origin);

  const { param } = parseRequestUrl(req);
  const agentName = param('agentName');

  if (!agentName) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'agentName query parameter is required' }));
    return;
  }

  const running = ctx.runningAgents.get(agentName);
  if (!running) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: `Agent "${agentName}" is not running` }));
    return;
  }

  try {
    const cardRes = await fetch(`http://localhost:${running.port}/.well-known/agent.json`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });

    if (!cardRes.ok) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: `Agent card not available (${cardRes.status})` }));
      return;
    }

    const card = await cardRes.json();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, card }));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: `Failed to fetch agent card: ${(err as Error).message}` }));
  }
}
