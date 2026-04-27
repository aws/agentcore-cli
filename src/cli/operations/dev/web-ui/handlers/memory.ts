import type { RouteContext } from './route-context';
import { parseRequestUrl } from './route-context';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * GET /api/memory?memoryName=xxx&namespace=yyy[&strategyId=zzz]
 * Lists memory records. Requires onListMemoryRecords handler.
 */
export async function handleListMemoryRecords(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  origin?: string
): Promise<void> {
  if (!ctx.options.onListMemoryRecords) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Memory browsing is not available' }));
    return;
  }

  const { param } = parseRequestUrl(req);
  const memoryName = param('memoryName');
  const namespace = param('namespace');
  const strategyId = param('strategyId');

  if (!memoryName) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'memoryName query parameter is required' }));
    return;
  }

  if (!namespace) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'namespace query parameter is required' }));
    return;
  }

  try {
    const result = await ctx.options.onListMemoryRecords(memoryName, namespace, strategyId);
    ctx.setCorsHeaders(res, origin);
    res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    ctx.options.onLog?.('error', `List memory records error: ${err instanceof Error ? err.message : String(err)}`);
    ctx.setCorsHeaders(res, origin);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Failed to list memory records' }));
  }
}

/**
 * POST /api/memory/search — semantic search across memory records.
 * Body: { memoryName, namespace, searchQuery, strategyId? }
 * Requires onRetrieveMemoryRecords handler.
 */
export async function handleRetrieveMemoryRecords(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  origin?: string
): Promise<void> {
  if (!ctx.options.onRetrieveMemoryRecords) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Memory search is not available' }));
    return;
  }

  const body = await ctx.readBody(req);
  let memoryName: string | undefined;
  let namespace: string | undefined;
  let searchQuery: string | undefined;
  let strategyId: string | undefined;

  try {
    const parsed = JSON.parse(body) as {
      memoryName?: string;
      namespace?: string;
      searchQuery?: string;
      strategyId?: string;
    };
    memoryName = parsed.memoryName;
    namespace = parsed.namespace;
    searchQuery = parsed.searchQuery;
    strategyId = parsed.strategyId;
  } catch {
    // fall through
  }

  if (!memoryName) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'memoryName is required' }));
    return;
  }

  if (!namespace) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'namespace is required' }));
    return;
  }

  if (!searchQuery) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'searchQuery is required' }));
    return;
  }

  try {
    const result = await ctx.options.onRetrieveMemoryRecords(memoryName, namespace, searchQuery, strategyId);
    ctx.setCorsHeaders(res, origin);
    res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    ctx.options.onLog?.('error', `Retrieve memory records error: ${err instanceof Error ? err.message : String(err)}`);
    ctx.setCorsHeaders(res, origin);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Failed to search memory records' }));
  }
}
