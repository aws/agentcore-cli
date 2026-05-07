import { handleGetCloudWatchTrace, handleListCloudWatchTraces } from '../handlers/cloudwatch-traces.js';
import type { RouteContext } from '../handlers/route-context.js';
import type { IncomingMessage, ServerResponse } from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function mockRes(): ServerResponse & { _status: number; _headers: Record<string, string>; _body: string } {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: '',
    writeHead(status: number, headers?: Record<string, string>) {
      res._status = status;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    setHeader(name: string, value: string) {
      res._headers[name] = value;
    },
    end(body?: string) {
      if (body) res._body = body;
    },
  };
  return res as unknown as ServerResponse & { _status: number; _headers: Record<string, string>; _body: string };
}

function mockReq(url: string): IncomingMessage {
  return { url, headers: { host: 'localhost:8081' } } as unknown as IncomingMessage;
}

function mockCtx(overrides: Partial<RouteContext['options']> = {}): RouteContext {
  return {
    options: {
      mode: 'dev',
      agents: [],
      harnesses: [],
      uiPort: 8081,
      ...overrides,
    },
    runningAgents: new Map(),
    startingAgents: new Map(),
    agentErrors: new Map(),
    setCorsHeaders: vi.fn(),
    readBody: vi.fn(),
  } as RouteContext;
}

describe('handleListCloudWatchTraces', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 404 when no handler configured', async () => {
    const ctx = mockCtx();
    const req = mockReq('/api/cloudwatch-traces?agentName=my-agent');
    const res = mockRes();

    await handleListCloudWatchTraces(ctx, req, res);

    expect(res._status).toBe(404);
    const body = JSON.parse(res._body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('not available');
  });

  it('returns 400 when neither agentName nor harnessName provided', async () => {
    const handler = vi.fn();
    const ctx = mockCtx({ onListCloudWatchTraces: handler });
    const req = mockReq('/api/cloudwatch-traces');
    const res = mockRes();

    await handleListCloudWatchTraces(ctx, req, res);

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('agentName');
    expect(body.error).toContain('harnessName');
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 400 when both agentName and harnessName provided', async () => {
    const handler = vi.fn();
    const ctx = mockCtx({ onListCloudWatchTraces: handler });
    const req = mockReq('/api/cloudwatch-traces?agentName=a&harnessName=h');
    const res = mockRes();

    await handleListCloudWatchTraces(ctx, req, res);

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('agentName');
    expect(body.error).toContain('harnessName');
    expect(handler).not.toHaveBeenCalled();
  });

  it('calls handler with agentName and returns traces', async () => {
    const traces = [{ traceId: 't1' }, { traceId: 't2' }];
    const handler = vi.fn().mockResolvedValue({ success: true, traces });
    const ctx = mockCtx({ onListCloudWatchTraces: handler });
    const req = mockReq('/api/cloudwatch-traces?agentName=my-agent');
    const res = mockRes();

    await handleListCloudWatchTraces(ctx, req, res);

    expect(res._status).toBe(200);
    expect(handler).toHaveBeenCalledWith('my-agent', undefined, undefined, undefined);
    const body = JSON.parse(res._body);
    expect(body.success).toBe(true);
    expect(body.traces).toEqual(traces);
  });

  it('calls handler with harnessName', async () => {
    const handler = vi.fn().mockResolvedValue({ success: true, traces: [] });
    const ctx = mockCtx({ onListCloudWatchTraces: handler });
    const req = mockReq('/api/cloudwatch-traces?harnessName=my-harness');
    const res = mockRes();

    await handleListCloudWatchTraces(ctx, req, res);

    expect(res._status).toBe(200);
    expect(handler).toHaveBeenCalledWith(undefined, 'my-harness', undefined, undefined);
  });

  it('returns 500 when handler throws', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    const ctx = mockCtx({ onListCloudWatchTraces: handler });
    const req = mockReq('/api/cloudwatch-traces?agentName=my-agent');
    const res = mockRes();

    await handleListCloudWatchTraces(ctx, req, res);

    expect(res._status).toBe(500);
    const body = JSON.parse(res._body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('Failed to list CloudWatch traces');
  });

  it('returns 400 for invalid startTime', async () => {
    const handler = vi.fn();
    const ctx = mockCtx({ onListCloudWatchTraces: handler });
    const req = mockReq('/api/cloudwatch-traces?agentName=my-agent&startTime=notanumber');
    const res = mockRes();

    await handleListCloudWatchTraces(ctx, req, res);

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('startTime');
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('handleGetCloudWatchTrace', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 404 when no handler configured', async () => {
    const ctx = mockCtx();
    const req = mockReq('/api/cloudwatch-traces/abc123?agentName=my-agent');
    const res = mockRes();

    await handleGetCloudWatchTrace(ctx, req, res);

    expect(res._status).toBe(404);
    const body = JSON.parse(res._body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('not available');
  });

  it('returns 400 when traceId is missing', async () => {
    const handler = vi.fn();
    const ctx = mockCtx({ onGetCloudWatchTrace: handler });
    const req = mockReq('/api/cloudwatch-traces/?agentName=my-agent');
    const res = mockRes();

    await handleGetCloudWatchTrace(ctx, req, res);

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('traceId');
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 400 when neither agentName nor harnessName provided', async () => {
    const handler = vi.fn();
    const ctx = mockCtx({ onGetCloudWatchTrace: handler });
    const req = mockReq('/api/cloudwatch-traces/abc123');
    const res = mockRes();

    await handleGetCloudWatchTrace(ctx, req, res);

    expect(res._status).toBe(400);
    const body = JSON.parse(res._body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('agentName');
    expect(body.error).toContain('harnessName');
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 500 when handler throws', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('boom'));
    const ctx = mockCtx({ onGetCloudWatchTrace: handler });
    const req = mockReq('/api/cloudwatch-traces/abc123?agentName=my-agent');
    const res = mockRes();

    await handleGetCloudWatchTrace(ctx, req, res);

    expect(res._status).toBe(500);
    const body = JSON.parse(res._body);
    expect(body.success).toBe(false);
    expect(body.error).toContain('Failed to get CloudWatch trace');
  });

  it('calls handler and returns records', async () => {
    const records = [{ record: 'data1' }];
    const handler = vi.fn().mockResolvedValue({ success: true, records });
    const ctx = mockCtx({ onGetCloudWatchTrace: handler });
    const req = mockReq('/api/cloudwatch-traces/abc123?agentName=my-agent');
    const res = mockRes();

    await handleGetCloudWatchTrace(ctx, req, res);

    expect(res._status).toBe(200);
    expect(handler).toHaveBeenCalledWith('my-agent', undefined, 'abc123', undefined, undefined);
    const body = JSON.parse(res._body);
    expect(body.success).toBe(true);
    expect(body.records).toEqual(records);
  });
});
