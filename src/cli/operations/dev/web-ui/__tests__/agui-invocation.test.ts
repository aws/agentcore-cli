import { handleInvocations } from '../handlers/invocations.js';
import type { RouteContext } from '../handlers/route-context.js';
import type { IncomingMessage, ServerResponse } from 'http';
import { request as httpRequest } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// handleAguiInvocation proxies to the agent via node:http. Mock it so we can
// capture the RunAgentInput body that would be sent to the agent's
// /invocations path, without opening a real socket.
vi.mock('node:http', () => ({
  request: vi.fn(),
}));

// Keep the AWS SDK / project-config modules out of this unit test — the local
// AGUI path never calls them, but invocations.ts imports them at module load.
vi.mock('../../../../aws/agentcore', () => ({
  invokeAgentRuntimeStreaming: vi.fn(),
  invokeA2ARuntime: vi.fn(),
  invokeAguiRuntime: vi.fn(),
}));
vi.mock('../../../../aws/agui-types', () => ({
  buildAguiRunInput: vi.fn(),
}));
vi.mock('../../../../commands/invoke/resolve', () => ({
  resolveInvokeTarget: vi.fn(),
}));
vi.mock('../../../../../lib', () => {
  const MockConfigIO = vi.fn();
  MockConfigIO.prototype.readProjectSpec = vi.fn();
  MockConfigIO.prototype.readDeployedState = vi.fn();
  MockConfigIO.prototype.readAWSDeploymentTargets = vi.fn();
  return { ConfigIO: MockConfigIO };
});

interface MockRes extends ServerResponse {
  _status: number;
  _headers: Record<string, string>;
  _body: string;
  _chunks: string[];
}

function mockRes(): MockRes {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: '',
    _chunks: [] as string[],
    headersSent: false,
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      res.headersSent = true;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    setHeader(name: string, value: string) {
      res._headers[name] = value;
    },
    write(chunk: string) {
      res._chunks.push(chunk);
      return true;
    },
    end(body?: string) {
      if (body) res._body = body;
    },
  };
  return res as unknown as MockRes;
}

function mockReq(url: string): IncomingMessage {
  return { url, headers: { host: 'localhost:8081' } } as unknown as IncomingMessage;
}

function mockCtx(bodyValue?: string): RouteContext {
  return {
    options: {
      mode: 'dev',
      agents: [],
      harnesses: [],
      uiPort: 8081,
      configRoot: '/tmp/test-project/agentcore',
    },
    runningAgents: new Map(),
    startingAgents: new Map(),
    agentErrors: new Map(),
    setCorsHeaders: vi.fn(),
    readBody: vi.fn().mockResolvedValue(bodyValue ?? ''),
  } as RouteContext;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Drive the mocked `httpRequest` so each proxied AGUI body is captured into
 * `captured`, in call order. The fake agent responds 200 with an SSE
 * content-type and ends immediately so the handler's promise settles.
 */
function captureProxiedAguiBodies(captured: string[]): void {
  vi.mocked(httpRequest).mockImplementation(((_opts, cb) => {
    const agentRes = {
      headers: { 'content-type': 'text/event-stream' },
      statusCode: 200,
      pipe: vi.fn(),
      on: vi.fn((event: string, done: (...args: unknown[]) => void) => {
        // Settle the handler promise as soon as the 'end' listener attaches.
        if (event === 'end') done();
      }),
    };
    const proxyReq = {
      write: vi.fn((body: string) => {
        captured.push(body);
      }),
      end: vi.fn(),
      on: vi.fn(),
    };
    (cb as unknown as (r: typeof agentRes) => void)(agentRes);
    return proxyReq as unknown as ReturnType<typeof httpRequest>;
  }) as typeof httpRequest);
}

describe('handleInvocations AGUI threadId (#1678)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reuses the per-chat sessionId as threadId across messages', async () => {
    const captured: string[] = [];
    captureProxiedAguiBodies(captured);

    const sessionId = 'stable-session-id';
    const body = JSON.stringify({ agentName: 'test-agent', sessionId, prompt: 'hello' });
    const ctx = mockCtx(body);
    ctx.runningAgents.set('test-agent', {
      server: {} as never,
      port: 9999,
      protocol: 'AGUI',
    });

    // Two consecutive messages within the same chat session.
    await handleInvocations(ctx, mockReq('/invocations'), mockRes());
    await handleInvocations(ctx, mockReq('/invocations'), mockRes());

    expect(captured).toHaveLength(2);
    const first = JSON.parse(captured[0]!) as { threadId: string; messages: { content: string }[] };
    const second = JSON.parse(captured[1]!) as { threadId: string };
    // Regression: before #1678, threadId was randomUUID() per message, so the
    // agent saw a fresh thread for every message and lost multi-turn state
    // (e.g. AgentCore Memory STM). Both messages must share the chat's threadId.
    expect(first.threadId).toBe(sessionId);
    expect(second.threadId).toBe(sessionId);
    expect(first.messages[0]?.content).toBe('hello');
  });

  it('falls back to a generated UUID threadId when no sessionId is supplied', async () => {
    const captured: string[] = [];
    captureProxiedAguiBodies(captured);

    const body = JSON.stringify({ agentName: 'test-agent', prompt: 'hello' });
    const ctx = mockCtx(body);
    ctx.runningAgents.set('test-agent', {
      server: {} as never,
      port: 9999,
      protocol: 'AGUI',
    });

    await handleInvocations(ctx, mockReq('/invocations'), mockRes());

    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]!) as { threadId: string };
    // The `?? randomUUID()` fallback must still yield a valid threadId.
    expect(parsed.threadId).toMatch(UUID_RE);
  });
});
