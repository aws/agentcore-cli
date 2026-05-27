/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-empty-function, require-yield, @typescript-eslint/unbound-method */
import { invokeHarness } from '../../../../aws/agentcore-harness';
import { handleHarnessInvocation } from '../handlers/harness-invocation';
import type { RouteContext } from '../handlers/route-context';
import type { ServerResponse } from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../aws/agentcore-harness', () => ({
  invokeHarness: vi.fn(),
}));

function mockRes(): ServerResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: string;
  _chunks: string[];
} {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: '',
    _chunks: [] as string[],
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    write(chunk: string) {
      res._chunks.push(chunk);
      return true;
    },
    end(body?: string) {
      if (body) res._body = body;
    },
  };
  return res as unknown as ServerResponse & {
    _status: number;
    _headers: Record<string, string>;
    _body: string;
    _chunks: string[];
  };
}

function mockCtx(overrides: Partial<RouteContext['options']> = {}): RouteContext {
  return {
    options: {
      mode: 'dev',
      harnesses: [
        { name: 'MyHarness', harnessArn: 'arn:aws:bedrock:us-west-2:123:harness/h-123', region: 'us-west-2' },
      ],
      ...overrides,
    } as RouteContext['options'],
    runningAgents: new Map(),
    startingAgents: new Map(),
    agentErrors: new Map(),
    setCorsHeaders: vi.fn(),
    readBody: vi.fn(),
  } as unknown as RouteContext;
}

describe('handleHarnessInvocation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 400 when harnessName is missing', async () => {
    const ctx = mockCtx();
    const res = mockRes();

    await handleHarnessInvocation(ctx, {}, res, undefined);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ success: false, error: 'harnessName is required' });
  });

  it('returns 400 when prompt is missing', async () => {
    const ctx = mockCtx();
    const res = mockRes();

    await handleHarnessInvocation(ctx, { harnessName: 'MyHarness' }, res, undefined);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ success: false, error: 'prompt is required' });
  });

  it('returns 404 when harness not found', async () => {
    const ctx = mockCtx();
    const res = mockRes();

    await handleHarnessInvocation(ctx, { harnessName: 'NonExistent', prompt: 'hello' }, res, undefined);

    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toEqual({ success: false, error: 'Harness "NonExistent" not found' });
  });

  it('returns 404 when no harnesses configured', async () => {
    const ctx = mockCtx({ harnesses: undefined });
    const res = mockRes();

    await handleHarnessInvocation(ctx, { harnessName: 'MyHarness', prompt: 'hello' }, res, undefined);

    expect(res._status).toBe(404);
  });

  it('streams SSE events on successful invocation', async () => {
    const ctx = mockCtx();
    const res = mockRes();

    const events = [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
    ];
    vi.mocked(invokeHarness).mockReturnValue(
      (async function* () {
        for (const e of events) yield e;
      })() as any
    );

    await handleHarnessInvocation(ctx, { harnessName: 'MyHarness', prompt: 'hello' }, res, undefined);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('text/event-stream');
    expect(res._chunks).toHaveLength(2);
    expect(res._chunks[0]!).toContain('data: ');
    expect(JSON.parse(res._chunks[0]!.replace('data: ', '').trim())).toEqual(events[0]);
  });

  it('streams error event on invocation failure', async () => {
    const ctx = mockCtx();
    const res = mockRes();

    vi.mocked(invokeHarness).mockReturnValue(
      (async function* () {
        throw new Error('Service unavailable');
      })() as any
    );

    await handleHarnessInvocation(ctx, { harnessName: 'MyHarness', prompt: 'hello' }, res, undefined);

    expect(res._status).toBe(200);
    expect(res._chunks).toHaveLength(1);
    const errorEvent = JSON.parse(res._chunks[0]!.replace('data: ', '').trim());
    expect(errorEvent.type).toBe('error');
    expect(errorEvent.message).toBe('Service unavailable');
  });

  it('sets x-session-id header with provided sessionId', async () => {
    const ctx = mockCtx();
    const res = mockRes();

    vi.mocked(invokeHarness).mockReturnValue((async function* () {})() as any);

    await handleHarnessInvocation(
      ctx,
      { harnessName: 'MyHarness', prompt: 'hello', sessionId: 'my-session-123' },
      res,
      undefined
    );

    expect(res._headers['x-session-id']).toBe('my-session-123');
  });

  it('generates sessionId when not provided', async () => {
    const ctx = mockCtx();
    const res = mockRes();

    vi.mocked(invokeHarness).mockReturnValue((async function* () {})() as any);

    await handleHarnessInvocation(ctx, { harnessName: 'MyHarness', prompt: 'hello' }, res, undefined);

    expect(res._headers['x-session-id']).toBeDefined();
    expect(res._headers['x-session-id']!.length).toBeGreaterThan(0);
  });

  it('sets CORS headers', async () => {
    const ctx = mockCtx();
    const res = mockRes();

    await handleHarnessInvocation(ctx, { harnessName: 'MyHarness' }, res, 'http://localhost:3000');

    expect(ctx.setCorsHeaders).toHaveBeenCalledWith(res, 'http://localhost:3000');
  });
});
