import { ConfigIO } from '../../../../../lib';
import { mcpCallTool, mcpInitSession, mcpListTools } from '../../../../aws/agentcore';
import { resolveInvokeTarget } from '../../../../commands/invoke/resolve';
import { type RouteContext, parseRequestUrl } from './route-context.js';
import type { IncomingMessage, ServerResponse } from 'http';

export async function handleMcpProxy(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  origin?: string
): Promise<void> {
  const { param } = parseRequestUrl(req);
  if (param('target') === 'deployed') {
    return handleDeployedMcpProxy(ctx, req, res, origin);
  }

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

async function handleDeployedMcpProxy(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  origin?: string
): Promise<void> {
  const { configRoot } = ctx.options;
  if (!configRoot) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'No agentcore project found' }));
    return;
  }

  const raw = await ctx.readBody(req);
  let parsed: {
    agentName?: string;
    targetName?: string;
    body?: Record<string, unknown>;
    sessionId?: string;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
    return;
  }

  const { agentName, targetName, body, sessionId } = parsed;

  if (!body) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'body is required' }));
    return;
  }

  const configIO = new ConfigIO({ baseDir: configRoot });
  let project;
  let deployedState;
  let awsTargets;
  try {
    project = await configIO.readProjectSpec();
    deployedState = await configIO.readDeployedState();
    awsTargets = await configIO.readAWSDeploymentTargets();
  } catch (err) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: false,
        error: `Failed to load config: ${err instanceof Error ? err.message : String(err)}`,
      })
    );
    return;
  }

  const resolved = await resolveInvokeTarget({
    project,
    deployedState,
    awsTargets,
    agentName,
    targetName,
    sessionId,
    configIO,
  });

  if (!resolved.success) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: resolved.error.message }));
    return;
  }

  const mcpOpts = {
    region: resolved.region,
    runtimeArn: resolved.runtimeArn,
    bearerToken: resolved.bearerToken,
    mcpSessionId: sessionId,
  };

  const method = (body as { method?: string }).method;

  try {
    if (method === 'initialize') {
      const mcpSessionId = await mcpInitSession(mcpOpts);
      ctx.setCorsHeaders(res, origin);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: { jsonrpc: '2.0', result: {} }, sessionId: mcpSessionId }));
    } else if (method === 'tools/list') {
      const { tools } = await mcpListTools(mcpOpts);
      ctx.setCorsHeaders(res, origin);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result: { jsonrpc: '2.0', result: { tools } } }));
    } else if (method === 'tools/call') {
      const params = (body as { params?: { name?: string; arguments?: Record<string, unknown> } }).params;
      if (!params?.name) {
        ctx.setCorsHeaders(res, origin);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'tools/call requires params.name' }));
        return;
      }
      const response = await mcpCallTool(mcpOpts, params.name, params.arguments ?? {});
      ctx.setCorsHeaders(res, origin);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          result: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: response }] } },
        })
      );
    } else {
      ctx.setCorsHeaders(res, origin);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: `Unsupported MCP method: ${method}` }));
    }
  } catch (err) {
    ctx.setCorsHeaders(res, origin);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(
      JSON.stringify({
        success: false,
        error: `MCP invoke failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    );
  }
}
