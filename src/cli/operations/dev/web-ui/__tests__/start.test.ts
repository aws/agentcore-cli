import type { DevConfig } from '../../config';
import * as serverModule from '../../server';
import type { RouteContext } from '../handlers/route-context.js';
import { handleStart } from '../handlers/start.js';
import type { IncomingMessage, ServerResponse } from 'http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the server module so we don't actually spawn dev processes or bind ports.
vi.mock('../../server', async () => {
  const actual = await vi.importActual<typeof import('../../server')>('../../server');
  return {
    ...actual,
    // findAvailablePort: configured per-test via mockImplementation below
    findAvailablePort: vi.fn((p: number) => Promise.resolve(p)),
    createDevServer: vi.fn(() => ({
      // The handler only null-checks `child`; cast to satisfy the type without
      // pretending to satisfy the full ChildProcess contract.
      start: vi.fn(() => Promise.resolve({} as never)),
      kill: vi.fn(),
    })),
  };
});

// Also mock waitForServerReady (imported by handlers/start.ts directly from '../../utils').
// Without this, tests fall through to a real 60s TCP probe loop after createDevServer.start()
// resolves, ballooning the file's runtime to several minutes and creating flakiness if anything
// happens to be listening on the resolved port.
vi.mock('../../utils', async () => {
  const actual = await vi.importActual<typeof import('../../utils')>('../../utils');
  return {
    ...actual,
    waitForServerReady: vi.fn(() => Promise.resolve(true)),
  };
});

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

function mockReq(body: object): IncomingMessage {
  const stream = Readable.from([JSON.stringify(body)]);
  return Object.assign(stream, {
    url: '/api/start',
    headers: { host: 'localhost:8081' },
  }) as unknown as IncomingMessage;
}

function makeDevConfig(overrides: Partial<DevConfig> = {}): DevConfig {
  return {
    agentName: 'AgentB',
    module: 'main:app',
    directory: '/tmp/agent',
    hasConfig: true,
    isPython: true,
    buildType: 'CodeZip',
    protocol: 'HTTP',
    ...overrides,
  };
}

function mockCtx(opts: {
  agentNames: string[];
  basePort?: number;
  basePortIsExplicit?: boolean;
  protocol?: 'HTTP' | 'A2A' | 'MCP';
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}): RouteContext {
  return {
    options: {
      mode: 'dev',
      agents: opts.agentNames.map(name => ({
        name,
        buildType: 'CodeZip' as const,
        protocol: opts.protocol ?? 'HTTP',
      })),
      uiPort: 8081,
      basePort: opts.basePort,
      basePortIsExplicit: opts.basePortIsExplicit,
      onLog: opts.onLog,
      getDevConfig: (name: string) => makeDevConfig({ agentName: name, protocol: opts.protocol ?? 'HTTP' }),
    },
    runningAgents: new Map(),
    startingAgents: new Map(),
    agentErrors: new Map(),
    setCorsHeaders: vi.fn(),
    readBody: (req: IncomingMessage) =>
      new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      }),
  } as unknown as RouteContext;
}

describe('handleStart - port resolution (issue #1079)', () => {
  const findAvailableMock = serverModule.findAvailablePort as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findAvailableMock.mockReset();
    findAvailableMock.mockResolvedValue(0);
    findAvailableMock.mockImplementation((p: number) => Promise.resolve(p) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs offset when basePort is implicit and agent index > 0', async () => {
    const logs: { level: string; msg: string }[] = [];
    const ctx = mockCtx({
      agentNames: ['AgentA', 'AgentB'],
      basePort: 8080,
      basePortIsExplicit: false,
      onLog: (level, msg) => logs.push({ level, msg }),
    });
    const req = mockReq({ agentName: 'AgentB' });
    const res = mockRes();

    await handleStart(ctx, req, res);

    // Expect findAvailablePort called with basePort + index = 8081
    expect(findAvailableMock).toHaveBeenCalledWith(8081);
    expect(logs.some(l => l.msg.includes('index 1') && l.msg.includes('8081'))).toBe(true);
  });

  it('honors basePort literally when explicit (no offset for index > 0)', async () => {
    const logs: { level: string; msg: string }[] = [];
    const ctx = mockCtx({
      agentNames: ['AgentA', 'AgentB'],
      basePort: 8788,
      basePortIsExplicit: true,
      onLog: (level, msg) => logs.push({ level, msg }),
    });
    const req = mockReq({ agentName: 'AgentB' });
    const res = mockRes();

    await handleStart(ctx, req, res);

    expect(findAvailableMock).toHaveBeenCalledWith(8788);
    expect(logs.some(l => l.msg.includes('index'))).toBe(false);
  });

  it('falls back to uiPort + 1 + index when basePort is undefined', async () => {
    const ctx = mockCtx({
      agentNames: ['AgentA', 'AgentB'],
    });
    const req = mockReq({ agentName: 'AgentB' });
    const res = mockRes();

    await handleStart(ctx, req, res);

    // uiPort=8081, +1, +index 1 = 8083
    expect(findAvailableMock).toHaveBeenCalledWith(8083);
  });

  it('returns 500 with explicit-conflict error when basePortIsExplicit and port is in use', async () => {
    findAvailableMock.mockImplementationOnce((p: number) => Promise.resolve(p + 5) as never); // simulate conflict
    const ctx = mockCtx({
      agentNames: ['AgentA'],
      basePort: 8788,
      basePortIsExplicit: true,
    });
    const req = mockReq({ agentName: 'AgentA' });
    const res = mockRes();

    await handleStart(ctx, req, res);

    expect(res._status).toBe(500);
    const body = JSON.parse(res._body);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/8788.*in use/);
  });

  it('explicit-conflict error mentions multi-runtime hint when more than one HTTP agent exists', async () => {
    findAvailableMock.mockImplementationOnce((p: number) => Promise.resolve(p + 5) as never); // simulate conflict
    const ctx = mockCtx({
      agentNames: ['AgentA', 'AgentB'],
      basePort: 8788,
      basePortIsExplicit: true,
    });
    const req = mockReq({ agentName: 'AgentA' });
    const res = mockRes();

    await handleStart(ctx, req, res);

    expect(res._status).toBe(500);
    const body = JSON.parse(res._body);
    expect(body.error).toMatch(/binds all HTTP runtimes to the same port/);
    expect(body.error).toMatch(/omit --port to auto-offset/);
  });

  it('ignores basePortIsExplicit when basePort is undefined (programmatic misuse guard)', async () => {
    const ctx = mockCtx({
      agentNames: ['AgentA', 'AgentB'],
      // basePort intentionally omitted while basePortIsExplicit is set
      basePortIsExplicit: true,
    });
    const req = mockReq({ agentName: 'AgentB' });
    const res = mockRes();

    await handleStart(ctx, req, res);

    // Falls back to legacy uiPort+1+index = 8083 (no fail-fast on explicit conflict).
    expect(findAvailableMock).toHaveBeenCalledWith(8083);
  });

  it('basePortIsExplicit without basePort + conflict still falls back to legacy log-and-continue (no 500)', async () => {
    // Simulate a conflict: findAvailablePort returns a different port. With
    // basePortIsExplicit=true but no basePort, the misuse guard must collapse
    // back to implicit semantics, which means logging the shift, NOT a 500.
    findAvailableMock.mockImplementationOnce((p: number) => Promise.resolve(p + 5) as never);
    const logs: { level: string; msg: string }[] = [];
    const ctx = mockCtx({
      agentNames: ['AgentA', 'AgentB'],
      // basePort intentionally omitted while basePortIsExplicit is set
      basePortIsExplicit: true,
      onLog: (level, msg) => logs.push({ level, msg }),
    });
    const req = mockReq({ agentName: 'AgentB' });
    const res = mockRes();

    await handleStart(ctx, req, res);

    // Must NOT return the explicit-conflict 500.
    expect(res._status).not.toBe(500);
    // Must emit the legacy "Port X in use, using Y" log.
    expect(logs.some(l => l.msg.includes('Port 8083 in use, using 8088'))).toBe(true);
  });

  it('A2A protocol with basePortIsExplicit=true: no "index N" log; A2A-specific conflict message', async () => {
    findAvailableMock.mockImplementationOnce((p: number) => Promise.resolve(p + 1) as never);
    const logs: { level: string; msg: string }[] = [];
    const ctx = mockCtx({
      agentNames: ['AgentA', 'AgentB'],
      basePort: 8080,
      basePortIsExplicit: true,
      protocol: 'A2A',
      onLog: (level, msg) => logs.push({ level, msg }),
    });
    const req = mockReq({ agentName: 'AgentB' });
    const res = mockRes();

    await handleStart(ctx, req, res);

    // A2A pin to 9000 regardless of basePort/index.
    expect(findAvailableMock).toHaveBeenCalledWith(9000);
    // No HTTP-only "index" offset log should fire for A2A agents.
    expect(logs.every(l => !l.msg.includes('index'))).toBe(true);
    // Conflict surfaces the A2A-specific message, not the HTTP "Pass a different --port" one.
    const body = JSON.parse(res._body);
    expect(body.error).toMatch(/A2A agents require port 9000/);
    expect(body.error).not.toMatch(/Pass a different --port/);
  });

  it('MCP protocol with basePortIsExplicit=true: no "index N" log; MCP-specific conflict message', async () => {
    findAvailableMock.mockImplementationOnce((p: number) => Promise.resolve(p + 1) as never);
    const logs: { level: string; msg: string }[] = [];
    const ctx = mockCtx({
      agentNames: ['AgentA', 'AgentB'],
      basePort: 8080,
      basePortIsExplicit: true,
      protocol: 'MCP',
      onLog: (level, msg) => logs.push({ level, msg }),
    });
    const req = mockReq({ agentName: 'AgentB' });
    const res = mockRes();

    await handleStart(ctx, req, res);

    // MCP pinned to 8000 regardless of basePort/index.
    expect(findAvailableMock).toHaveBeenCalledWith(8000);
    expect(logs.every(l => !l.msg.includes('index'))).toBe(true);
    const body = JSON.parse(res._body);
    expect(body.error).toMatch(/MCP agents require port 8000/);
    expect(body.error).not.toMatch(/Pass a different --port/);
  });
});
