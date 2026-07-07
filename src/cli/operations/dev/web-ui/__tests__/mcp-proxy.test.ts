import { ConfigIO } from '../../../../../lib';
import { mcpCallTool, mcpInitSession, mcpListTools } from '../../../../aws/agentcore';
import { resolveInvokeTarget } from '../../../../commands/invoke/resolve';
import { handleMcpProxy } from '../handlers/mcp-proxy.js';
import type { RouteContext } from '../handlers/route-context.js';
import type { IncomingMessage, ServerResponse } from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../commands/invoke/resolve', () => ({
  resolveInvokeTarget: vi.fn(),
}));

vi.mock('../../../../aws/agentcore', () => ({
  mcpInitSession: vi.fn(),
  mcpListTools: vi.fn(),
  mcpCallTool: vi.fn(),
}));

vi.mock('../../../../../lib', () => {
  const MockConfigIO = vi.fn();
  MockConfigIO.prototype.readProjectSpec = vi.fn();
  MockConfigIO.prototype.readDeployedState = vi.fn();
  MockConfigIO.prototype.readAWSDeploymentTargets = vi.fn();
  return { ConfigIO: MockConfigIO };
});

const mockedResolve = vi.mocked(resolveInvokeTarget);
const mockedMcpInitSession = vi.mocked(mcpInitSession);
const mockedMcpListTools = vi.mocked(mcpListTools);
const mockedMcpCallTool = vi.mocked(mcpCallTool);

function mockReq(url: string): IncomingMessage {
  return { url, headers: { host: 'localhost:8081' } } as unknown as IncomingMessage;
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
    options: { mode: 'dev', configRoot: '/tmp/test-project/agentcore' } as RouteContext['options'],
    runningAgents: new Map(),
    startingAgents: new Map(),
    agentErrors: new Map(),
    setCorsHeaders: vi.fn(),
    readBody: vi.fn(),
    ...overrides,
  } as unknown as RouteContext;
}

function mockDeployedCtx(overrides: Partial<RouteContext['options']> = {}, bodyValue?: string): RouteContext {
  return {
    options: {
      mode: 'dev',
      agents: [],
      harnesses: [],
      uiPort: 8081,
      configRoot: '/tmp/test-project/agentcore',
      ...overrides,
    },
    runningAgents: new Map(),
    startingAgents: new Map(),
    agentErrors: new Map(),
    setCorsHeaders: vi.fn(),
    readBody: vi.fn().mockResolvedValue(bodyValue ?? ''),
  } as RouteContext;
}

function mockConfigIO(overrides: Partial<{ project: unknown; state: unknown; targets: unknown }> = {}) {
  const proto = ConfigIO.prototype as any;
  proto.readProjectSpec.mockResolvedValue(overrides.project ?? {});
  proto.readDeployedState.mockResolvedValue(overrides.state ?? { targets: {} });
  proto.readAWSDeploymentTargets.mockResolvedValue(overrides.targets ?? []);
}

describe('handleMcpProxy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 400 when agentName is missing', async () => {
    const ctx = mockCtx({ readBody: vi.fn().mockResolvedValue(JSON.stringify({ body: {} })) });
    const req = mockReq('/api/mcp');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ success: false, error: 'agentName is required' });
  });

  it('returns 400 when body is missing', async () => {
    const ctx = mockCtx({ readBody: vi.fn().mockResolvedValue(JSON.stringify({ agentName: 'test-agent' })) });
    const req = mockReq('/api/mcp');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ success: false, error: 'body is required' });
  });

  it('returns 400 when agent is not running', async () => {
    const ctx = mockCtx({
      readBody: vi.fn().mockResolvedValue(JSON.stringify({ agentName: 'test-agent', body: { jsonrpc: '2.0' } })),
    });
    const req = mockReq('/api/mcp');
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
    const req = mockReq('/api/mcp');
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
    const req = mockReq('/api/mcp');
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
    const req = mockReq('/api/mcp');
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

describe('handleMcpProxy ?target=deployed', () => {
  const resolvedSuccess = {
    success: true as const,
    agentSpec: { name: 'mcp-agent', protocol: 'MCP' } as any,
    targetName: 'default',
    targetConfig: { name: 'default', region: 'us-east-1', account: '123' } as any,
    region: 'us-east-1',
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-1',
    bearerToken: 'tok-1',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigIO();
    mockedResolve.mockResolvedValue(resolvedSuccess);
  });

  it('returns 404 when no configRoot', async () => {
    const ctx = mockDeployedCtx({ configRoot: undefined }, JSON.stringify({ body: { method: 'initialize' } }));
    const req = mockReq('/api/mcp?target=deployed');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(404);
    expect(JSON.parse(res._body)).toEqual({ success: false, error: 'No agentcore project found' });
  });

  it('returns 400 on invalid JSON body', async () => {
    const ctx = mockDeployedCtx({}, 'not json');
    const req = mockReq('/api/mcp?target=deployed');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ success: false, error: 'Invalid JSON' });
  });

  it('returns 400 when body field is missing', async () => {
    const ctx = mockDeployedCtx({}, JSON.stringify({ agentName: 'my-agent' }));
    const req = mockReq('/api/mcp?target=deployed');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ success: false, error: 'body is required' });
  });

  it('returns 400 when resolveInvokeTarget fails', async () => {
    mockedResolve.mockResolvedValue({ success: false, error: new Error('Agent not deployed') });

    const ctx = mockDeployedCtx({}, JSON.stringify({ agentName: 'missing', body: { method: 'initialize' } }));
    const req = mockReq('/api/mcp?target=deployed');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ success: false, error: 'Agent not deployed' });
  });

  it('returns 500 when config loading throws', async () => {
    (ConfigIO.prototype as any).readProjectSpec.mockRejectedValue(new Error('file not found'));

    const ctx = mockDeployedCtx({}, JSON.stringify({ body: { method: 'initialize' } }));
    const req = mockReq('/api/mcp?target=deployed');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error).toContain('Failed to load config');
    expect(JSON.parse(res._body).error).toContain('file not found');
  });

  it('handles initialize method and returns sessionId', async () => {
    mockedMcpInitSession.mockResolvedValue('mcp-session-abc');

    const ctx = mockDeployedCtx({}, JSON.stringify({ agentName: 'mcp-agent', body: { method: 'initialize' } }));
    const req = mockReq('/api/mcp?target=deployed');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({
      success: true,
      result: { jsonrpc: '2.0', result: {} },
      sessionId: 'mcp-session-abc',
    });
  });

  it('handles tools/list method and excludes mcpSessionId from result', async () => {
    const toolsResult = { tools: [{ name: 'get_weather', description: 'Get weather' }], mcpSessionId: 'internal-sess' };
    mockedMcpListTools.mockResolvedValue(toolsResult as any);

    const ctx = mockDeployedCtx(
      {},
      JSON.stringify({ agentName: 'mcp-agent', body: { method: 'tools/list' }, sessionId: 'sess-1' })
    );
    const req = mockReq('/api/mcp?target=deployed');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(200);
    const parsed = JSON.parse(res._body);
    expect(parsed).toEqual({
      success: true,
      result: { jsonrpc: '2.0', result: { tools: toolsResult.tools } },
    });
    expect(parsed.result.result).not.toHaveProperty('mcpSessionId');
    expect(mockedMcpListTools).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-east-1',
        runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-1',
        bearerToken: 'tok-1',
        mcpSessionId: 'sess-1',
      })
    );
  });

  it('handles tools/call method', async () => {
    mockedMcpCallTool.mockResolvedValue('sunny, 72F');

    const ctx = mockDeployedCtx(
      {},
      JSON.stringify({
        agentName: 'mcp-agent',
        body: { method: 'tools/call', params: { name: 'get_weather', arguments: { city: 'NYC' } } },
        sessionId: 'sess-1',
      })
    );
    const req = mockReq('/api/mcp?target=deployed');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({
      success: true,
      result: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'sunny, 72F' }] } },
    });
    expect(mockedMcpCallTool).toHaveBeenCalledWith(expect.objectContaining({ mcpSessionId: 'sess-1' }), 'get_weather', {
      city: 'NYC',
    });
  });

  it('returns 400 when tools/call is missing params.name', async () => {
    const ctx = mockDeployedCtx(
      {},
      JSON.stringify({ agentName: 'mcp-agent', body: { method: 'tools/call', params: {} } })
    );
    const req = mockReq('/api/mcp?target=deployed');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ success: false, error: 'tools/call requires params.name' });
  });

  it('returns 400 for unsupported method', async () => {
    const ctx = mockDeployedCtx({}, JSON.stringify({ agentName: 'mcp-agent', body: { method: 'resources/list' } }));
    const req = mockReq('/api/mcp?target=deployed');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body)).toEqual({ success: false, error: 'Unsupported MCP method: resources/list' });
  });

  it('returns 502 when AWS SDK call throws', async () => {
    mockedMcpListTools.mockRejectedValue(new Error('ThrottlingException'));

    const ctx = mockDeployedCtx({}, JSON.stringify({ agentName: 'mcp-agent', body: { method: 'tools/list' } }));
    const req = mockReq('/api/mcp?target=deployed');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(res._status).toBe(502);
    expect(JSON.parse(res._body)).toEqual({
      success: false,
      error: 'MCP invoke failed: ThrottlingException',
    });
  });

  it('passes targetName to resolveInvokeTarget', async () => {
    mockedResolve.mockResolvedValue({ success: false, error: new Error('not found') });

    const ctx = mockDeployedCtx(
      {},
      JSON.stringify({ agentName: 'a', targetName: 'prod', body: { method: 'initialize' } })
    );
    const req = mockReq('/api/mcp?target=deployed');
    const res = mockRes();

    await handleMcpProxy(ctx, req, res, undefined);

    expect(mockedResolve).toHaveBeenCalledWith(expect.objectContaining({ targetName: 'prod' }));
  });
});
