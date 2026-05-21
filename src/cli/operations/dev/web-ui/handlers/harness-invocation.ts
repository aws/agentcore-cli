import { invokeHarness } from '../../../../aws/agentcore-harness';
import type { InvokeHarnessOptions } from '../../../../aws/agentcore-harness';
import type { HarnessInvocationOverrides } from '../api-types';
import { buildInvokeOptions } from './harness-utils';
import type { RouteContext } from './route-context';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

interface ParsedHarnessRequest {
  harnessName: string;
  prompt: string;
  sessionId: string;
  userId?: string;
  overrides?: HarnessInvocationOverrides;
}

function parseRequest(raw: Record<string, unknown>): { parsed?: ParsedHarnessRequest; error?: string } {
  const harnessName = raw.harnessName as string | undefined;
  if (!harnessName) return { error: 'harnessName is required' };

  const prompt = raw.prompt as string | undefined;
  if (!prompt) return { error: 'prompt is required' };

  return {
    parsed: {
      harnessName,
      prompt,
      sessionId: (raw.sessionId as string) || randomUUID(),
      userId: raw.userId as string | undefined,
      overrides: raw.harnessOverrides as HarnessInvocationOverrides | undefined,
    },
  };
}

export async function handleHarnessInvocation(
  ctx: RouteContext,
  body: Record<string, unknown>,
  res: ServerResponse,
  origin?: string
): Promise<void> {
  const { parsed, error } = parseRequest(body);
  if (!parsed) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
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

  const messages: InvokeHarnessOptions['messages'] = [{ role: 'user', content: [{ text: parsed.prompt }] }];

  const invokeOpts = buildInvokeOptions(
    harness.harnessArn,
    harness.region,
    parsed.sessionId,
    messages,
    parsed.overrides
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
