import { handleA2AAgentCard } from '../handlers/a2a-proxy.js';
import type { RouteContext } from '../handlers/route-context.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

function mockReq(): IncomingMessage {
  return {
    url: '/api/a2a/agent-card?agentName=test-agent',
    headers: { host: 'localhost:8081' },
  } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    writeHead(status: number) {
      res._status = status;
      return res;
    },
    setHeader: vi.fn(),
    end(body?: string) {
      if (body) res._body = body;
    },
  };
  return res as unknown as ServerResponse & { _status: number; _body: string };
}

function mockCtx(): RouteContext {
  return {
    options: { mode: 'dev' },
    runningAgents: new Map([['test-agent', { server: {} as never, port: 8082, protocol: 'A2A' }]]),
    startingAgents: new Map(),
    agentErrors: new Map(),
    setCorsHeaders: vi.fn(),
    readBody: vi.fn(),
  } as unknown as RouteContext;
}

describe('handleA2AAgentCard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the v1 agent card endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ name: 'v1-agent' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handleA2AAgentCard(mockCtx(), mockReq(), res);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![0]).toBe('http://localhost:8082/.well-known/agent-card.json');
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ success: true, card: { name: 'v1-agent' } });
  });

  it('falls back to the v0.3 agent card endpoint on 404', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ name: 'legacy-agent' }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const res = mockRes();

    await handleA2AAgentCard(mockCtx(), mockReq(), res);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toBe('http://localhost:8082/.well-known/agent.json');
    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ success: true, card: { name: 'legacy-agent' } });
  });
});
