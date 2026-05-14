import type { RouteContext } from '../handlers/route-context.js';
import { handleStatus } from '../handlers/status.js';
import type { ServerResponse } from 'http';
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

function mockCtx(overrides: Partial<RouteContext> = {}): RouteContext {
  return {
    options: {
      mode: 'dev',
      agents: [],
      harnesses: [],
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

describe('handleStatus', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty harnesses array when no harnesses configured', () => {
    const ctx = mockCtx();
    const res = mockRes();

    handleStatus(ctx, res, undefined);

    const body = JSON.parse(res._body);
    expect(body.harnesses).toEqual([]);
  });

  it('includes harnesses in status response', () => {
    const ctx = mockCtx({
      options: {
        mode: 'dev',
        agents: [{ name: 'my-agent', buildType: 'CodeZip', protocol: 'HTTP' }],
        harnesses: [
          {
            name: 'my-harness',
            harnessArn: 'arn:aws:bedrock-agentcore:us-west-2:123:harness/abc',
            region: 'us-west-2',
          },
        ],
        uiPort: 8081,
      },
    });
    const res = mockRes();

    handleStatus(ctx, res, undefined);

    const body = JSON.parse(res._body);
    expect(body.agents).toEqual([{ name: 'my-agent', buildType: 'CodeZip', protocol: 'HTTP' }]);
    expect(body.harnesses).toEqual([{ name: 'my-harness' }]);
  });

  it('returns harnesses alongside running agents and errors', () => {
    const agents = new Map([['my-agent', { server: {} as any, port: 8082, protocol: 'HTTP' }]]);
    const agentErrors = new Map([['broken-agent', { message: 'crash', timestamp: 1 }]]);
    const ctx = mockCtx({
      options: {
        mode: 'dev',
        agents: [
          { name: 'my-agent', buildType: 'CodeZip', protocol: 'HTTP' },
          { name: 'broken-agent', buildType: 'CodeZip', protocol: 'HTTP' },
        ],
        harnesses: [
          { name: 'harness-1', harnessArn: 'arn:1', region: 'us-east-1' },
          { name: 'harness-2', harnessArn: 'arn:2', region: 'us-west-2' },
        ],
        uiPort: 8081,
      },
      runningAgents: agents,
      agentErrors,
    });
    const res = mockRes();

    handleStatus(ctx, res, undefined);

    const body = JSON.parse(res._body);
    expect(body.harnesses).toHaveLength(2);
    expect(body.harnesses[0].name).toBe('harness-1');
    expect(body.harnesses[1].name).toBe('harness-2');
    expect(body.running).toHaveLength(1);
    expect(body.errors).toHaveLength(1);
  });
});
