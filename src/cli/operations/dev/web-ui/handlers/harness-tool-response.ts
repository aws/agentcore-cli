import { invokeHarness } from '../../../../aws/agentcore-harness';
import type { HarnessInvocationOverrides } from '../api-types';
import { buildInvokeOptions } from './harness-utils';
import type { RouteContext } from './route-context';
import type { IncomingMessage, ServerResponse } from 'node:http';

interface ParsedToolResponseRequest {
  harnessName: string;
  sessionId: string;
  messages: { role: string; content: Record<string, unknown>[] }[];
  harnessOverrides?: HarnessInvocationOverrides;
}

function parseToolResponseRequest(body: string): {
  parsed?: ParsedToolResponseRequest;
  error?: string;
  status?: number;
} {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return { error: 'Invalid JSON', status: 400 };
  }

  if (!raw.harnessName) return { error: 'harnessName is required', status: 400 };
  if (!raw.messages || !Array.isArray(raw.messages)) return { error: 'messages array is required', status: 400 };
  if (!raw.sessionId) return { error: 'sessionId is required', status: 400 };

  return {
    parsed: {
      harnessName: raw.harnessName as string,
      sessionId: raw.sessionId as string,
      messages: raw.messages as ParsedToolResponseRequest['messages'],
      harnessOverrides: raw.harnessOverrides as HarnessInvocationOverrides | undefined,
    },
  };
}

export async function handleHarnessToolResponse(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  origin?: string
): Promise<void> {
  const body = await ctx.readBody(req);

  const { parsed, error, status } = parseToolResponseRequest(body);
  if (!parsed) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(status ?? 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error }));
    return;
  }

  const harness = (ctx.options.harnesses ?? []).find(h => h.name === parsed.harnessName);
  if (!harness) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: `Harness "${parsed.harnessName}" not found` }));
    return;
  }

  const invokeOpts = buildInvokeOptions(
    harness.harnessArn,
    harness.region,
    parsed.sessionId,
    parsed.messages,
    parsed.harnessOverrides
  );

  ctx.setCorsHeaders(res, origin);
  const sseHeaders: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'x-session-id': parsed.sessionId,
  };
  res.writeHead(200, sseHeaders);

  try {
    const stream = invokeHarness(invokeOpts);
    for await (const event of stream) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.write(`data: ${JSON.stringify({ type: 'error', errorType: 'invocationError', message })}\n\n`);
  }

  res.end();
}
