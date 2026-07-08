import { handleInvocations } from '../handlers/invocations.js';
import type { RouteContext } from '../handlers/route-context.js';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { capturedBodies, requestMock } = vi.hoisted(() => ({
  capturedBodies: [] as string[],
  requestMock: vi.fn(),
}));

vi.mock('node:http', () => ({
  request: requestMock,
}));

interface MockRes extends ServerResponse {
  _status: number;
  _headers: Record<string, string>;
  _chunks: string[];
}

function mockRes(): MockRes {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
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
      if (body) res._chunks.push(body);
      return res;
    },
  };
  return res as unknown as MockRes;
}

function mockReq(): IncomingMessage {
  return { url: '/invocations', headers: { host: 'localhost:8081' } } as unknown as IncomingMessage;
}

function mockCtx(bodyValue: string): RouteContext {
  return {
    options: {
      mode: 'dev',
      agents: [],
      harnesses: [],
      uiPort: 8081,
      configRoot: '/tmp/test-project/agentcore',
    },
    runningAgents: new Map([['agui-agent', { server: {} as never, port: 8082, protocol: 'AGUI' }]]),
    startingAgents: new Map(),
    agentErrors: new Map(),
    setCorsHeaders: vi.fn(),
    readBody: vi.fn().mockResolvedValue(bodyValue),
  } as RouteContext;
}

describe('handleInvocations local AGUI proxy', () => {
  beforeEach(() => {
    capturedBodies.length = 0;
    requestMock.mockReset();
    requestMock.mockImplementation((_options, callback: (res: EventEmitter & Record<string, unknown>) => void) => {
      const proxyReq = new EventEmitter() as EventEmitter & {
        end: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
      };
      proxyReq.write = vi.fn((chunk: string) => {
        capturedBodies.push(chunk);
        return true;
      });
      proxyReq.end = vi.fn(() => {
        const agentRes = new EventEmitter() as EventEmitter & Record<string, unknown>;
        agentRes.headers = { 'content-type': 'text/event-stream' };
        agentRes.statusCode = 200;
        agentRes.pipe = vi.fn((res: MockRes) => {
          res.write('data: {"type":"RUN_FINISHED"}\n\n');
          return res;
        });
        callback(agentRes);
        agentRes.emit('end');
      });
      return proxyReq;
    });
  });

  it('uses the browser session id as the AGUI thread id across messages', async () => {
    const firstBody = JSON.stringify({ agentName: 'agui-agent', prompt: 'hello', sessionId: 'browser-session-1' });
    const secondBody = JSON.stringify({ agentName: 'agui-agent', prompt: 'again', sessionId: 'browser-session-1' });

    await handleInvocations(mockCtx(firstBody), mockReq(), mockRes());
    await handleInvocations(mockCtx(secondBody), mockReq(), mockRes());

    const aguiBodies = capturedBodies.map(body => JSON.parse(body) as { threadId: string; runId: string });
    expect(aguiBodies).toHaveLength(2);
    expect(aguiBodies.map(body => body.threadId)).toEqual(['browser-session-1', 'browser-session-1']);
    expect(aguiBodies[0]!.runId).not.toBe(aguiBodies[1]!.runId);
  });
});
