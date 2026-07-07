import { ConfigIO } from '../../../../../lib';
import { invokeA2ARuntime, invokeAgentRuntimeStreaming, invokeAguiRuntime } from '../../../../aws/agentcore';
import { resolveInvokeTarget } from '../../../../commands/invoke/resolve';
import { handleInvocations } from '../handlers/invocations.js';
import type { RouteContext } from '../handlers/route-context.js';
import type { IncomingMessage, ServerResponse } from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../commands/invoke/resolve', () => ({
  resolveInvokeTarget: vi.fn(),
}));

vi.mock('../../../../aws/agentcore', () => ({
  invokeAgentRuntimeStreaming: vi.fn(),
  invokeA2ARuntime: vi.fn(),
  invokeAguiRuntime: vi.fn(),
}));

vi.mock('../../../../aws/agui-types', () => ({
  buildAguiRunInput: vi.fn((_prompt: string, _session?: string) => ({ prompt: _prompt })),
}));

vi.mock('../../../../../lib', () => {
  const MockConfigIO = vi.fn();
  MockConfigIO.prototype.readProjectSpec = vi.fn();
  MockConfigIO.prototype.readDeployedState = vi.fn();
  MockConfigIO.prototype.readAWSDeploymentTargets = vi.fn();
  return { ConfigIO: MockConfigIO };
});

const mockedResolve = vi.mocked(resolveInvokeTarget);
const mockedInvokeStreaming = vi.mocked(invokeAgentRuntimeStreaming);
const mockedInvokeA2A = vi.mocked(invokeA2ARuntime);
const mockedInvokeAgui = vi.mocked(invokeAguiRuntime);

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

function mockCtx(overrides: Partial<RouteContext['options']> = {}, bodyValue?: string): RouteContext {
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

async function* streamChunks(chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) {
    await Promise.resolve();
    yield chunk;
  }
}

async function* failingStream(chunks: unknown[], error: Error): AsyncGenerator<unknown> {
  for (const chunk of chunks) {
    await Promise.resolve();
    yield chunk;
  }
  throw error;
}

function mockConfigIO(overrides: Partial<{ project: unknown; state: unknown; targets: unknown }> = {}) {
  const proto = ConfigIO.prototype as any;
  proto.readProjectSpec.mockResolvedValue(overrides.project ?? {});
  proto.readDeployedState.mockResolvedValue(overrides.state ?? { targets: {} });
  proto.readAWSDeploymentTargets.mockResolvedValue(overrides.targets ?? []);
}

describe('handleInvocations ?target=deployed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigIO();
  });

  it('returns 404 when no configRoot', async () => {
    const ctx = mockCtx({ configRoot: undefined }, JSON.stringify({ prompt: 'hello' }));
    const req = mockReq('/invocations?target=deployed');
    const res = mockRes();

    await handleInvocations(ctx, req, res);

    expect(res._status).toBe(404);
    expect(JSON.parse(res._body).error).toContain('No agentcore project found');
  });

  it('returns 400 for invalid JSON body', async () => {
    const ctx = mockCtx({}, 'not json');
    const req = mockReq('/invocations?target=deployed');
    const res = mockRes();

    await handleInvocations(ctx, req, res);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toContain('Invalid JSON body');
  });

  it('returns 400 when prompt is missing', async () => {
    const ctx = mockCtx({}, JSON.stringify({ agentName: 'my-agent' }));
    const req = mockReq('/invocations?target=deployed');
    const res = mockRes();

    await handleInvocations(ctx, req, res);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toContain('prompt is required');
  });

  it('returns 400 when resolve fails', async () => {
    mockedResolve.mockResolvedValue({
      success: false,
      error: new Error('Agent not deployed'),
    });

    const ctx = mockCtx({}, JSON.stringify({ prompt: 'hello', agentName: 'missing' }));
    const req = mockReq('/invocations?target=deployed');
    const res = mockRes();

    await handleInvocations(ctx, req, res);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error).toBe('Agent not deployed');
  });

  it('passes targetName to resolveInvokeTarget', async () => {
    mockedResolve.mockResolvedValue({
      success: false,
      error: new Error('not found'),
    });

    const ctx = mockCtx({}, JSON.stringify({ prompt: 'hi', agentName: 'a', targetName: 'prod' }));
    const req = mockReq('/invocations?target=deployed');
    const res = mockRes();

    await handleInvocations(ctx, req, res);

    expect(mockedResolve).toHaveBeenCalledWith(expect.objectContaining({ targetName: 'prod' }));
  });

  it('invokes HTTP streaming for default protocol', async () => {
    mockedResolve.mockResolvedValue({
      success: true,
      agentSpec: { name: 'my-agent', protocol: 'HTTP' } as any,
      targetName: 'default',
      targetConfig: { name: 'default', region: 'us-east-1', account: '123' } as any,
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-1',
      sessionId: 'sess-1',
    });

    mockedInvokeStreaming.mockResolvedValue({
      stream: streamChunks([{ text: 'Hello' }, { text: ' world' }]),
      sessionId: 'sess-1',
    } as any);

    const ctx = mockCtx({}, JSON.stringify({ prompt: 'hi' }));
    const req = mockReq('/invocations?target=deployed');
    const res = mockRes();

    await handleInvocations(ctx, req, res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('text/event-stream');
    expect(res._chunks).toHaveLength(2);
    expect(res._chunks[0]).toContain('"text":"Hello"');
    expect(res._chunks[1]).toContain('"text":" world"');
  });

  it('invokes A2A for A2A protocol agents', async () => {
    mockedResolve.mockResolvedValue({
      success: true,
      agentSpec: { name: 'a2a-agent', protocol: 'A2A' } as any,
      targetName: 'default',
      targetConfig: { name: 'default', region: 'us-west-2', account: '123' } as any,
      region: 'us-west-2',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-west-2:123:runtime/rt-2',
      sessionId: 'sess-2',
    });

    mockedInvokeA2A.mockResolvedValue({
      stream: streamChunks([{ type: 'message', content: 'done' }]),
      sessionId: 'sess-2',
    } as any);

    const ctx = mockCtx({}, JSON.stringify({ prompt: 'run task' }));
    const req = mockReq('/invocations?target=deployed');
    const res = mockRes();

    await handleInvocations(ctx, req, res);

    expect(mockedInvokeA2A).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us-west-2', runtimeArn: expect.stringContaining('rt-2') }),
      'run task'
    );
    expect(res._status).toBe(200);
    expect(res._chunks).toHaveLength(1);
  });

  it('invokes AGUI for AGUI protocol agents', async () => {
    mockedResolve.mockResolvedValue({
      success: true,
      agentSpec: { name: 'agui-agent', protocol: 'AGUI' } as any,
      targetName: 'default',
      targetConfig: { name: 'default', region: 'us-east-1', account: '123' } as any,
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-3',
      sessionId: 'sess-3',
      bearerToken: 'tok-123',
    });

    mockedInvokeAgui.mockResolvedValue({
      textStream: streamChunks([{ event: 'text', data: 'hi' }]),
      sessionId: 'sess-3',
    } as any);

    const ctx = mockCtx({}, JSON.stringify({ prompt: 'do thing' }));
    const req = mockReq('/invocations?target=deployed');
    const res = mockRes();

    await handleInvocations(ctx, req, res);

    expect(mockedInvokeAgui).toHaveBeenCalled();
    expect(res._status).toBe(200);
    expect(res._chunks).toHaveLength(1);
  });

  it('emits SSE error frame and ends response on mid-stream failure', async () => {
    mockedResolve.mockResolvedValue({
      success: true,
      agentSpec: { name: 'my-agent', protocol: 'HTTP' } as any,
      targetName: 'default',
      targetConfig: { name: 'default', region: 'us-east-1', account: '123' } as any,
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/rt-1',
      sessionId: 'sess-1',
    });

    mockedInvokeStreaming.mockResolvedValue({
      stream: failingStream([{ text: 'partial' }], new Error('connection reset')),
      sessionId: 'sess-1',
    } as any);

    const ctx = mockCtx({}, JSON.stringify({ prompt: 'hi' }));
    const req = mockReq('/invocations?target=deployed');
    const res = mockRes();

    await handleInvocations(ctx, req, res);

    expect(res._status).toBe(200);
    expect(res._chunks[0]).toContain('"text":"partial"');
    const errorChunk = res._chunks.find(c => c.includes('"error"'));
    expect(errorChunk).toBeDefined();
    expect(errorChunk).toContain('connection reset');
  });

  it('returns 500 when config loading fails', async () => {
    (ConfigIO.prototype as any).readProjectSpec.mockRejectedValue(new Error('file not found'));

    const ctx = mockCtx({}, JSON.stringify({ prompt: 'hi' }));
    const req = mockReq('/invocations?target=deployed');
    const res = mockRes();

    await handleInvocations(ctx, req, res);

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error).toContain('Failed to load config');
  });
});
