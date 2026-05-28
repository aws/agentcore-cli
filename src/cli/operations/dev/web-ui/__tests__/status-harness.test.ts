import type { RouteContext } from '../handlers/route-context';
import { handleStatus } from '../handlers/status';
import type { ServerResponse } from 'http';
import { describe, expect, it, vi } from 'vitest';

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
    end(body?: string) {
      if (body) res._body = body;
    },
  };
  return res as unknown as ServerResponse & { _status: number; _headers: Record<string, string>; _body: string };
}

function mockCtx(overrides: Partial<RouteContext['options']> = {}): RouteContext {
  return {
    options: {
      mode: 'dev',
      agents: [],
      harnesses: [{ name: 'MyHarness' }],
      selectedAgent: undefined,
      selectedHarness: 'MyHarness',
      ...overrides,
    } as RouteContext['options'],
    runningAgents: new Map(),
    startingAgents: new Map(),
    agentErrors: new Map(),
    setCorsHeaders: vi.fn(),
    readBody: vi.fn(),
  } as unknown as RouteContext;
}

describe('handleStatus - harness fields', () => {
  it('includes harnesses array in response', () => {
    const ctx = mockCtx();
    const res = mockRes();

    handleStatus(ctx, res, undefined);

    const body = JSON.parse(res._body);
    expect(body.harnesses).toEqual([{ name: 'MyHarness' }]);
  });

  it('includes selectedHarness in response', () => {
    const ctx = mockCtx();
    const res = mockRes();

    handleStatus(ctx, res, undefined);

    const body = JSON.parse(res._body);
    expect(body.selectedHarness).toBe('MyHarness');
  });

  it('returns empty harnesses when none configured', () => {
    const ctx = mockCtx({ harnesses: undefined });
    const res = mockRes();

    handleStatus(ctx, res, undefined);

    const body = JSON.parse(res._body);
    expect(body.harnesses).toEqual([]);
  });

  it('includes mode in response', () => {
    const ctx = mockCtx();
    const res = mockRes();

    handleStatus(ctx, res, undefined);

    const body = JSON.parse(res._body);
    expect(body.mode).toBe('dev');
  });
});
