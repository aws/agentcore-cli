import type { RouteContext } from './route-context';
import { parseRequestUrl } from './route-context';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * GET /api/cloudwatch-traces?agentName=xxx or ?harnessName=xxx — list recent CloudWatch traces.
 * Exactly one of agentName or harnessName must be provided.
 */
export async function handleListCloudWatchTraces(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  origin?: string
): Promise<void> {
  const { param } = parseRequestUrl(req);
  const handler = ctx.options.onListCloudWatchTraces;

  if (!handler) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'CloudWatch traces are not available' }));
    return;
  }

  const agentName = param('agentName');
  const harnessName = param('harnessName');

  if (!agentName && !harnessName) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Either agentName or harnessName query parameter is required' }));
    return;
  }

  if (agentName && harnessName) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: false,
        error: 'Provide either agentName or harnessName, not both',
      })
    );
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
    const result = await handler(agentName, harnessName, startTime, endTime);
    ctx.setCorsHeaders(res, origin);
    res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    ctx.options.onLog?.('error', `List CloudWatch traces error: ${err instanceof Error ? err.message : String(err)}`);
    ctx.setCorsHeaders(res, origin);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Failed to list CloudWatch traces' }));
  }
}

/**
 * GET /api/cloudwatch-traces/:traceId?agentName=xxx or ?harnessName=xxx — get full CloudWatch trace data.
 * Exactly one of agentName or harnessName must be provided.
 */
export async function handleGetCloudWatchTrace(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  origin?: string
): Promise<void> {
  const { pathname, param } = parseRequestUrl(req);
  const handler = ctx.options.onGetCloudWatchTrace;

  if (!handler) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'CloudWatch traces are not available' }));
    return;
  }

  const traceId = pathname.replace('/api/cloudwatch-traces/', '');
  const agentName = param('agentName');
  const harnessName = param('harnessName');

  if (!traceId) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'traceId is required in the URL path' }));
    return;
  }

  if (!/^[a-fA-F0-9-]+$/.test(traceId)) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Invalid trace ID format' }));
    return;
  }

  if (!agentName && !harnessName) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Either agentName or harnessName query parameter is required' }));
    return;
  }

  if (agentName && harnessName) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: false,
        error: 'Provide either agentName or harnessName, not both',
      })
    );
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
    const result = await handler(agentName, harnessName, traceId, startTime, endTime);
    ctx.setCorsHeaders(res, origin);
    res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    ctx.options.onLog?.('error', `Get CloudWatch trace error: ${err instanceof Error ? err.message : String(err)}`);
    ctx.setCorsHeaders(res, origin);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Failed to get CloudWatch trace' }));
  }
}
