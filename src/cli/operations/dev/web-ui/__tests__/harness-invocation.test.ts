import { invokeHarness } from '../../../../aws/agentcore-harness.js';
import type { HarnessStreamEvent } from '../../../../aws/agentcore-harness.js';
import { handleHarnessInvocation } from '../handlers/harness-invocation.js';
import type { RouteContext } from '../handlers/route-context.js';
import type { ServerResponse } from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../aws/agentcore-harness.js', () => ({
  invokeHarness: vi.fn(),
}));

function mockRes(): ServerResponse & {
  _status: number;
  _headers: Record<string, string>;
  _chunks: string[];
  _ended: boolean;
} {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _chunks: [] as string[],
    _ended: false,
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
      if (body) res._chunks.push(body);
      res._ended = true;
    },
  };
  return res as unknown as ServerResponse & {
    _status: number;
    _headers: Record<string, string>;
    _chunks: string[];
    _ended: boolean;
  };
}

function mockCtx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    options: {
      mode: 'dev',
      agents: [],
      harnesses: [
        {
          name: 'test-harness',
          harnessArn: 'arn:aws:bedrock-agentcore:us-west-2:123:harness/abc',
          region: 'us-west-2',
        },
      ],
      uiPort: 8081,
    },
    runningAgents: new Map(),
    startingAgents: new Map(),
    agentErrors: new Map(),
    setCorsHeaders: vi.fn(),
    readBody: vi.fn(),
    ...overrides,
  };
}

async function* fakeStream(events: HarnessStreamEvent[]): AsyncGenerator<HarnessStreamEvent> {
  for (const event of events) {
    yield await Promise.resolve(event);
  }
}

describe('handleHarnessInvocation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 400 when harnessName is missing', async () => {
    const ctx = mockCtx();
    const res = mockRes();

    await handleHarnessInvocation(ctx, { prompt: 'hello' }, res, undefined);

    expect(res._status).toBe(400);
    expect(res._chunks[0]).toBeDefined();
    expect(JSON.parse(res._chunks[0]!)).toEqual({ success: false, error: 'harnessName is required' });
  });

  it('returns 400 when prompt is missing', async () => {
    const ctx = mockCtx();
    const res = mockRes();

    await handleHarnessInvocation(ctx, { harnessName: 'test-harness' }, res, undefined);

    expect(res._status).toBe(400);
    expect(res._chunks[0]).toBeDefined();
    expect(JSON.parse(res._chunks[0]!)).toEqual({ success: false, error: 'prompt is required' });
  });

  it('returns 404 when harness not found in config', async () => {
    const ctx = mockCtx();
    const res = mockRes();

    await handleHarnessInvocation(ctx, { harnessName: 'unknown', prompt: 'hello' }, res, undefined);

    expect(res._status).toBe(404);
    expect(res._chunks[0]).toBeDefined();
    expect(JSON.parse(res._chunks[0]!)).toEqual({ success: false, error: 'Harness "unknown" not found' });
  });

  it('streams structured SSE events from harness', async () => {
    const events: HarnessStreamEvent[] = [
      { type: 'messageStart', role: 'assistant' },
      { type: 'contentBlockDelta', contentBlockIndex: 0, delta: { type: 'text', text: 'Hello' } },
      { type: 'messageStop', stopReason: 'end_turn' },
      { type: 'metadata', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, metrics: { latencyMs: 100 } },
    ];
    vi.mocked(invokeHarness).mockReturnValue(fakeStream(events));

    const ctx = mockCtx();
    const res = mockRes();

    await handleHarnessInvocation(
      ctx,
      { harnessName: 'test-harness', prompt: 'hello', sessionId: 'sess-1' },
      res,
      undefined
    );

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('text/event-stream');
    expect(res._headers['x-session-id']).toBe('sess-1');

    const sseLines = res._chunks.filter(c => c.startsWith('data: '));
    expect(sseLines).toHaveLength(4);
    expect(sseLines[0]).toBeDefined();
    expect(sseLines[1]).toBeDefined();
    expect(sseLines[2]).toBeDefined();
    expect(sseLines[3]).toBeDefined();
    expect(JSON.parse(sseLines[0]!.slice(6))).toEqual({ type: 'messageStart', role: 'assistant' });
    expect(JSON.parse(sseLines[1]!.slice(6))).toMatchObject({ type: 'contentBlockDelta', delta: { text: 'Hello' } });
    expect(JSON.parse(sseLines[2]!.slice(6))).toEqual({ type: 'messageStop', stopReason: 'end_turn' });
    expect(JSON.parse(sseLines[3]!.slice(6))).toMatchObject({ type: 'metadata' });
  });

  it('passes overrides to invokeHarness', async () => {
    vi.mocked(invokeHarness).mockReturnValue(
      fakeStream([
        { type: 'messageStart', role: 'assistant' },
        { type: 'messageStop', stopReason: 'end_turn' },
      ])
    );

    const ctx = mockCtx();
    const res = mockRes();
    const overrides = { maxTokens: 500, systemPrompt: 'Be brief' };

    await handleHarnessInvocation(
      ctx,
      { harnessName: 'test-harness', prompt: 'hi', sessionId: 'sess-1', harnessOverrides: overrides },
      res,
      undefined
    );

    expect(invokeHarness).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTokens: 500,
        systemPrompt: [{ text: 'Be brief' }],
        harnessArn: 'arn:aws:bedrock-agentcore:us-west-2:123:harness/abc',
        region: 'us-west-2',
      })
    );
  });

  it('streams error event when invokeHarness throws', async () => {
    vi.mocked(invokeHarness).mockImplementation(() => {
      throw new Error('AWS credentials expired');
    });

    const ctx = mockCtx();
    const res = mockRes();

    await handleHarnessInvocation(
      ctx,
      { harnessName: 'test-harness', prompt: 'hello', sessionId: 'sess-1' },
      res,
      undefined
    );

    expect(res._status).toBe(200);
    const sseLines = res._chunks.filter(c => c.startsWith('data: '));
    expect(sseLines).toHaveLength(1);
    expect(sseLines[0]).toBeDefined();
    const errorEvent = JSON.parse(sseLines[0]!.slice(6));
    expect(errorEvent.type).toBe('error');
    expect(errorEvent.message).toContain('AWS credentials expired');
  });
});
