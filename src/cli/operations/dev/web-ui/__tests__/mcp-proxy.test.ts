import { handleMcpProxy } from '../handlers/mcp-proxy.js';
import type { RouteContext } from '../handlers/route-context.js';
import type { IncomingMessage, ServerResponse } from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function mockReq(_body: string): IncomingMessage {
  return {} as IncomingMessage;
}

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

function mockCtx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    options: { mode: 'dev' } as RouteContext['options'],
    runningAgents: new Map(),
    startingAgents: new Map(),
    agentErrors: new Map(),
    setCorsHeaders: vi.fn(),
    readBody: vi.fn(),
    ...overrides,
  } as unknown as RouteContext;
}

describe('handleMcpProxy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 400 when agentName is missing', async () => {
    const ctx = mockCtx({ readBody: vi.fn().mockResolvedValue(JSON.stringify({ body: {} })) });
    const req = mockReq('');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ success: false, error: 'agentName is required' });
  });

  it('returns 400 when body is missing', async () => {
    const ctx = mockCtx({ readBody: vi.fn().mockResolvedValue(JSON.stringify({ agentName: 'test-agent' })) });
    const req = mockReq('');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ success: false, error: 'body is required' });
  });

  it('returns 400 when agent is not running', async () => {
    const ctx = mockCtx({
      readBody: vi.fn().mockResolvedValue(JSON.stringify({ agentName: 'test-agent', body: { jsonrpc: '2.0' } })),
    });
    const req = mockReq('');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ success: false, error: 'Agent "test-agent" is not running' });
  });

  it('forwards JSON-RPC to agent and returns result', async () => {
    const agents = new Map([['test-agent', { server: {} as any, port: 8082, protocol: 'MCP' }]]);
    const jsonRpcBody = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    const ctx = mockCtx({
      runningAgents: agents,
      readBody: vi.fn().mockResolvedValue(JSON.stringify({ agentName: 'test-agent', body: jsonRpcBody })),
    });
    const req = mockReq('');
    const res = mockRes();

    const mcpResponse = { jsonrpc: '2.0', id: 1, result: { tools: [] } };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'mcp-session-id': 'session-123' }),
        text: () => Promise.resolve(JSON.stringify(mcpResponse)),
      })
    );

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(200);
    const parsed = JSON.parse(res._body);
    expect(parsed).toEqual({ success: true, result: mcpResponse, sessionId: 'session-123' });

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(fetchCall[0]).toBe('http://localhost:8082/mcp');
    expect(JSON.parse(fetchCall[1].body)).toEqual(jsonRpcBody);

    vi.unstubAllGlobals();
  });

  it('passes mcp-session-id header from request to agent', async () => {
    const agents = new Map([['test-agent', { server: {} as any, port: 8082, protocol: 'MCP' }]]);
    const jsonRpcBody = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} };
    const ctx = mockCtx({
      runningAgents: agents,
      readBody: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify({ agentName: 'test-agent', body: jsonRpcBody, sessionId: 'existing-session' })
        ),
    });
    const req = mockReq('');
    const res = mockRes();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({}),
        text: () => Promise.resolve(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })),
      })
    );

    await handleMcpProxy(ctx, req, res, undefined);

    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(fetchCall[1].headers['mcp-session-id']).toBe('existing-session');

    vi.unstubAllGlobals();
  });

  it('returns 502 when agent returns non-ok response', async () => {
    const agents = new Map([['test-agent', { server: {} as any, port: 8082, protocol: 'MCP' }]]);
    const ctx = mockCtx({
      runningAgents: agents,
      readBody: vi
        .fn()
        .mockResolvedValue(
          JSON.stringify({ agentName: 'test-agent', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
        ),
    });
    const req = mockReq('');
    const res = mockRes();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      })
    );

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(502);
    expect(JSON.parse(res._body)).toEqual({ success: false, error: 'MCP server returned status 500' });

    vi.unstubAllGlobals();
  });
});
