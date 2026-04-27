import type { RouteContext } from './route-context';
import { parseRequestUrl } from './route-context';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * GET /api/traces?agentName=xxx — list recent traces.
 * Returns local OTEL traces when the collector is active.
 */
export async function handleListTraces(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  origin?: string
): Promise<void> {
  const { param } = parseRequestUrl(req);
  const handler = ctx.options.onListTraces;

  if (!handler) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Traces are not available' }));
    return;
  }

  const agentName = param('agentName');

  // Parse optional date range query params (epoch milliseconds)
  const startTimeRaw = param('startTime');
  const endTimeRaw = param('endTime');
  const startTime = startTimeRaw ? Number(startTimeRaw) : undefined;
  const endTime = endTimeRaw ? Number(endTimeRaw) : undefined;

  if (startTimeRaw && isNaN(startTime!)) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'startTime must be a number (epoch milliseconds)' }));
    return;
  }
  if (endTimeRaw && isNaN(endTime!)) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'endTime must be a number (epoch milliseconds)' }));
    return;
  }

  try {
    const result = await handler(agentName, startTime, endTime);
    ctx.setCorsHeaders(res, origin);
    res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    ctx.options.onLog?.('error', `List traces error: ${err instanceof Error ? err.message : String(err)}`);
    ctx.setCorsHeaders(res, origin);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Failed to list traces' }));
  }
}

/**
 * GET /api/traces/:traceId?agentName=xxx — get full trace data.
 * Returns local OTEL trace spans and logs when the collector is active.
 */
export async function handleGetTrace(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  origin?: string
): Promise<void> {
  const { pathname, param } = parseRequestUrl(req);
  const handler = ctx.options.onGetTrace;

  if (!handler) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Traces are not available' }));
    return;
  }

  const traceId = pathname.replace('/api/traces/', '');
  const agentName = param('agentName');

  if (!traceId) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'traceId is required in the URL path' }));
    return;
  }

  // Parse optional date range query params (epoch milliseconds)
  const startTimeRaw = param('startTime');
  const endTimeRaw = param('endTime');
  const startTime = startTimeRaw ? Number(startTimeRaw) : undefined;
  const endTime = endTimeRaw ? Number(endTimeRaw) : undefined;

  if (startTimeRaw && isNaN(startTime!)) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'startTime must be a number (epoch milliseconds)' }));
    return;
  }
  if (endTimeRaw && isNaN(endTime!)) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'endTime must be a number (epoch milliseconds)' }));
    return;
  }

  try {
    const result = await handler(agentName, traceId, startTime, endTime);
    ctx.setCorsHeaders(res, origin);
    res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    ctx.options.onLog?.('error', `Get trace error: ${err instanceof Error ? err.message : String(err)}`);
    ctx.setCorsHeaders(res, origin);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Failed to get trace' }));
  }
}
