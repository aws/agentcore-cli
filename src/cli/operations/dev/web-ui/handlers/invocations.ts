import { extractSSEEventText, extractTaskText, isStatusUpdateEvent } from '../../invoke-a2a';
import type { RouteContext } from './route-context';
import { randomUUID } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, request as httpRequest } from 'node:http';

let a2aRequestId = 1;

/**
 * POST /invocations — proxy to the selected agent.
 * Body must include agentName to route to the correct running agent.
 */
export async function handleInvocations(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  origin?: string
): Promise<void> {
  const body = await ctx.readBody(req);

  let agentPort: number | undefined;
  let agentName: string | undefined;
  let agentProtocol: string | undefined;
  let sessionId: string | undefined;
  let userId: string | undefined;
  try {
    const parsed = JSON.parse(body) as { agentName?: string; sessionId?: string; userId?: string };
    agentName = parsed.agentName;
    sessionId = parsed.sessionId ?? randomUUID();
    userId = parsed.userId;
    if (agentName) {
      const running = ctx.runningAgents.get(agentName);
      agentPort = running?.port;
      agentProtocol = running?.protocol;
    }
  } catch {
    // fall through
  }

  // Clear any previous runtime error for this agent so stale errors don't persist
  if (agentName) {
    ctx.agentErrors.delete(agentName);
  }

  // Fall back to first running agent
  if (agentPort === undefined) {
    const first = ctx.runningAgents.values().next().value;
    agentPort = first?.port;
    agentProtocol = first?.protocol;
  }

  if (agentPort === undefined) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'No agent is running. Call POST /api/start first.' }));
    return;
  }

  // A2A agents use JSON-RPC at root path, not /invocations
  if (agentProtocol === 'A2A') {
    return handleA2AInvocation(ctx, res, body, agentPort, sessionId, origin);
  }

  // AGUI agents need RunAgentInput body; SSE response is passed through raw
  if (agentProtocol === 'AGUI') {
    return handleAguiInvocation(ctx, res, body, agentPort, sessionId, userId, origin);
  }

  return new Promise<void>((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-amzn-bedrock-agentcore-runtime-session-id': sessionId ?? randomUUID(),
    };
    if (userId) {
      headers['x-amzn-bedrock-agentcore-runtime-user-id'] = userId;
    }

    const proxyReq = httpRequest(
      {
        hostname: '127.0.0.1',
        port: agentPort,
        path: '/invocations',
        method: 'POST',
        headers,
      },
      agentRes => {
        const contentType = agentRes.headers['content-type'] ?? 'text/plain';
        ctx.setCorsHeaders(res, origin);
        const responseHeaders: Record<string, string> = { 'Content-Type': contentType };
        if (sessionId) {
          responseHeaders['x-session-id'] = sessionId;
        }
        res.writeHead(agentRes.statusCode ?? 200, responseHeaders);
        agentRes.pipe(res);
        agentRes.on('end', resolve);
        agentRes.on('error', reject);
      }
    );

    proxyReq.on('error', err => {
      if (!res.headersSent) {
        ctx.setCorsHeaders(res, origin);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `Agent server error: ${err.message}` }));
      }
      resolve();
    });

    proxyReq.write(body);
    proxyReq.end();
  });
}

/**
 * Handle invocation for A2A agents.
 * Translates the frontend { prompt } payload into A2A JSON-RPC message/stream,
 * proxies to the agent's root path, and transforms the A2A SSE response into
 * the format useStreamingChat expects (data: "text"\n\n).
 */
async function handleA2AInvocation(
  ctx: RouteContext,
  res: ServerResponse,
  rawBody: string,
  agentPort: number,
  sessionId?: string,
  origin?: string
): Promise<void> {
  let prompt: string;
  try {
    const parsed = JSON.parse(rawBody) as { prompt?: string };
    prompt = parsed.prompt ?? '';
  } catch {
    prompt = '';
  }

  if (!prompt) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'prompt is required' }));
    return;
  }

  const a2aBody = {
    jsonrpc: '2.0',
    id: a2aRequestId++,
    method: 'message/stream',
    params: {
      message: {
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text: prompt }],
        ...(sessionId ? { contextId: sessionId } : {}),
      },
    },
  };

  let agentRes: Response;
  try {
    agentRes = await fetch(`http://127.0.0.1:${agentPort}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(a2aBody),
    });
  } catch (err) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: `A2A agent error: ${(err as Error).message}` }));
    return;
  }

  if (!agentRes.ok) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: `A2A agent returned ${agentRes.status}` }));
    return;
  }

  const contentType = agentRes.headers.get('content-type') ?? '';
  ctx.setCorsHeaders(res, origin);

  // Streaming SSE response — transform A2A events to useStreamingChat format
  if (contentType.includes('text/event-stream') && agentRes.body) {
    const sseHeaders: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    };
    if (sessionId) sseHeaders['x-session-id'] = sessionId;
    res.writeHead(200, sseHeaders);

    const reader = (agentRes.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamedFromStatus = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;

          try {
            const event = JSON.parse(data) as Record<string, unknown>;
            const text = extractSSEEventText(event, streamedFromStatus);
            if (text) {
              if (isStatusUpdateEvent(event)) streamedFromStatus = true;
              res.write(`data: ${JSON.stringify(text)}\n\n`);
            }
          } catch {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    res.end();
    return;
  }

  // Non-streaming fallback: extract text from JSON-RPC result
  const responseText = await agentRes.text();
  try {
    const json = JSON.parse(responseText) as Record<string, unknown>;
    const result = json.result as Record<string, unknown> | undefined;
    const text = result ? (extractTaskText(result) ?? JSON.stringify(result, null, 2)) : responseText;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(text)}\n\n`);
    res.end();
  } catch {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(responseText);
  }
}

/**
 * Handle invocation for AGUI agents.
 * Translates the frontend { prompt } payload into AGUI RunAgentInput and
 * proxies to the agent's /invocations path. The SSE response is passed
 * through as-is — the frontend parses typed AG-UI events directly.
 */
async function handleAguiInvocation(
  ctx: RouteContext,
  res: ServerResponse,
  rawBody: string,
  agentPort: number,
  sessionId?: string,
  userId?: string,
  origin?: string
): Promise<void> {
  let prompt: string;
  try {
    const parsed = JSON.parse(rawBody) as { prompt?: string };
    prompt = parsed.prompt ?? '';
  } catch {
    prompt = '';
  }

  if (!prompt) {
    ctx.setCorsHeaders(res, origin);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'prompt is required' }));
    return;
  }

  // Build RunAgentInput — the body format AGUI agents expect
  const aguiBody = JSON.stringify({
    threadId: randomUUID(),
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: 'user', content: prompt }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });

  // Proxy to agent, piping the SSE response through untouched
  return new Promise<void>((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (sessionId) {
      headers['x-amzn-bedrock-agentcore-runtime-session-id'] = sessionId;
    }
    if (userId) {
      headers['x-amzn-bedrock-agentcore-runtime-user-id'] = userId;
    }

    const proxyReq = httpRequest(
      {
        hostname: '127.0.0.1',
        port: agentPort,
        path: '/invocations',
        method: 'POST',
        headers,
      },
      agentRes => {
        const contentType = agentRes.headers['content-type'] ?? 'text/plain';
        ctx.setCorsHeaders(res, origin);
        const responseHeaders: Record<string, string> = { 'Content-Type': contentType };
        if (sessionId) {
          responseHeaders['x-session-id'] = sessionId;
        }
        res.writeHead(agentRes.statusCode ?? 200, responseHeaders);
        agentRes.pipe(res);
        agentRes.on('end', resolve);
        agentRes.on('error', reject);
      }
    );

    proxyReq.on('error', err => {
      if (!res.headersSent) {
        ctx.setCorsHeaders(res, origin);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `AGUI agent error: ${err.message}` }));
      }
      resolve();
    });

    proxyReq.write(aguiBody);
    proxyReq.end();
  });
}
