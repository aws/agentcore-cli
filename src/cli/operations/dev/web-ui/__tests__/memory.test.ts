import { handleListMemoryRecords, handleRetrieveMemoryRecords } from '../handlers/memory.js';
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

function mockCtx(overrides: Partial<RouteContext['options']> = {}, bodyValue?: string): RouteContext {
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
    readBody: bodyValue !== undefined ? vi.fn().mockResolvedValue(bodyValue) : vi.fn(),
  } as RouteContext;
}

describe('handleListMemoryRecords', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 404 when no handler is wired', async () => {
    const ctx = mockCtx();
    const req = mockReq('/api/memory?memoryName=m&namespace=/a/');
    const res = mockRes();

    await handleListMemoryRecords(ctx, req, res);

    expect(res._status).toBe(404);
    expect(JSON.parse(res._body).error).toContain('not available');
  });

  it('returns 400 when memoryName is missing', async () => {
    const onListMemoryRecords = vi.fn();
    const ctx = mockCtx({ onListMemoryRecords });
    const req = mockReq('/api/memory?namespace=/a/');
    const res = mockRes();

    await handleListMemoryRecords(ctx, req, res);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toContain('memoryName');
    expect(onListMemoryRecords).not.toHaveBeenCalled();
  });

  it('returns 400 when both namespace and namespacePath are provided', async () => {
    const onListMemoryRecords = vi.fn();
    const ctx = mockCtx({ onListMemoryRecords });
    const req = mockReq('/api/memory?memoryName=m&namespace=/a/&namespacePath=/b/');
    const res = mockRes();

    await handleListMemoryRecords(ctx, req, res);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toContain('mutually exclusive');
    expect(onListMemoryRecords).not.toHaveBeenCalled();
  });

  it('returns 400 when neither namespace nor namespacePath is provided', async () => {
    const onListMemoryRecords = vi.fn();
    const ctx = mockCtx({ onListMemoryRecords });
    const req = mockReq('/api/memory?memoryName=m');
    const res = mockRes();

    await handleListMemoryRecords(ctx, req, res);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toContain("either 'namespace' or 'namespacePath'");
    expect(onListMemoryRecords).not.toHaveBeenCalled();
  });

  it('forwards namespace to handler when only namespace is provided', async () => {
    const onListMemoryRecords = vi.fn().mockResolvedValue({ success: true, records: [] });
    const ctx = mockCtx({ onListMemoryRecords });
    const req = mockReq('/api/memory?memoryName=m&namespace=/exact/');
    const res = mockRes();

    await handleListMemoryRecords(ctx, req, res);

    expect(res._status).toBe(200);
    expect(onListMemoryRecords).toHaveBeenCalledWith({
      memoryName: 'm',
      strategyId: undefined,
      namespace: '/exact/',
    });
  });

  it('forwards namespacePath to handler when only namespacePath is provided', async () => {
    const onListMemoryRecords = vi.fn().mockResolvedValue({ success: true, records: [] });
    const ctx = mockCtx({ onListMemoryRecords });
    const req = mockReq('/api/memory?memoryName=m&namespacePath=/prefix/');
    const res = mockRes();

    await handleListMemoryRecords(ctx, req, res);

    expect(res._status).toBe(200);
    expect(onListMemoryRecords).toHaveBeenCalledWith({
      memoryName: 'm',
      strategyId: undefined,
      namespacePath: '/prefix/',
    });
  });

  it('forwards strategyId when provided', async () => {
    const onListMemoryRecords = vi.fn().mockResolvedValue({ success: true, records: [] });
    const ctx = mockCtx({ onListMemoryRecords });
    const req = mockReq('/api/memory?memoryName=m&namespace=/a/&strategyId=s-1');
    const res = mockRes();

    await handleListMemoryRecords(ctx, req, res);

    expect(onListMemoryRecords).toHaveBeenCalledWith({
      memoryName: 'm',
      strategyId: 's-1',
      namespace: '/a/',
    });
  });
});

describe('handleRetrieveMemoryRecords', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 404 when no handler is wired', async () => {
    const ctx = mockCtx({}, JSON.stringify({ memoryName: 'm', namespace: '/a/', searchQuery: 'q' }));
    const req = mockReq('/api/memory/search');
    const res = mockRes();

    await handleRetrieveMemoryRecords(ctx, req, res);

    expect(res._status).toBe(404);
    expect(JSON.parse(res._body).error).toContain('not available');
  });

  it('returns 400 when memoryName is missing', async () => {
    const onRetrieveMemoryRecords = vi.fn();
    const ctx = mockCtx({ onRetrieveMemoryRecords }, JSON.stringify({ namespace: '/a/', searchQuery: 'q' }));
    const req = mockReq('/api/memory/search');
    const res = mockRes();

    await handleRetrieveMemoryRecords(ctx, req, res);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toContain('memoryName');
    expect(onRetrieveMemoryRecords).not.toHaveBeenCalled();
  });

  it('returns 400 when both namespace and namespacePath are in the body', async () => {
    const onRetrieveMemoryRecords = vi.fn();
    const ctx = mockCtx(
      { onRetrieveMemoryRecords },
      JSON.stringify({ memoryName: 'm', namespace: '/a/', namespacePath: '/b/', searchQuery: 'q' })
    );
    const req = mockReq('/api/memory/search');
    const res = mockRes();

    await handleRetrieveMemoryRecords(ctx, req, res);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toContain('mutually exclusive');
    expect(onRetrieveMemoryRecords).not.toHaveBeenCalled();
  });

  it('returns 400 when neither namespace nor namespacePath is in the body', async () => {
    const onRetrieveMemoryRecords = vi.fn();
    const ctx = mockCtx({ onRetrieveMemoryRecords }, JSON.stringify({ memoryName: 'm', searchQuery: 'q' }));
    const req = mockReq('/api/memory/search');
    const res = mockRes();

    await handleRetrieveMemoryRecords(ctx, req, res);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toContain("either 'namespace' or 'namespacePath'");
    expect(onRetrieveMemoryRecords).not.toHaveBeenCalled();
  });

  it('returns 400 when searchQuery is missing', async () => {
    const onRetrieveMemoryRecords = vi.fn();
    const ctx = mockCtx({ onRetrieveMemoryRecords }, JSON.stringify({ memoryName: 'm', namespace: '/a/' }));
    const req = mockReq('/api/memory/search');
    const res = mockRes();

    await handleRetrieveMemoryRecords(ctx, req, res);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toContain('searchQuery');
    expect(onRetrieveMemoryRecords).not.toHaveBeenCalled();
  });

  it('forwards namespace to handler when only namespace is provided', async () => {
    const onRetrieveMemoryRecords = vi.fn().mockResolvedValue({ success: true, records: [] });
    const ctx = mockCtx(
      { onRetrieveMemoryRecords },
      JSON.stringify({ memoryName: 'm', namespace: '/exact/', searchQuery: 'q' })
    );
    const req = mockReq('/api/memory/search');
    const res = mockRes();

    await handleRetrieveMemoryRecords(ctx, req, res);

    expect(res._status).toBe(200);
    expect(onRetrieveMemoryRecords).toHaveBeenCalledWith({
      memoryName: 'm',
      searchQuery: 'q',
      strategyId: undefined,
      namespace: '/exact/',
    });
  });

  it('forwards namespacePath to handler when only namespacePath is provided', async () => {
    const onRetrieveMemoryRecords = vi.fn().mockResolvedValue({ success: true, records: [] });
    const ctx = mockCtx(
      { onRetrieveMemoryRecords },
      JSON.stringify({ memoryName: 'm', namespacePath: '/prefix/', searchQuery: 'q' })
    );
    const req = mockReq('/api/memory/search');
    const res = mockRes();

    await handleRetrieveMemoryRecords(ctx, req, res);

    expect(res._status).toBe(200);
    expect(onRetrieveMemoryRecords).toHaveBeenCalledWith({
      memoryName: 'm',
      searchQuery: 'q',
      strategyId: undefined,
      namespacePath: '/prefix/',
    });
  });
});
