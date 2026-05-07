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
      start: vi.fn(() => Promise.resolve({ pid: 1234, killed: false })),
      kill: vi.fn(),
    })),
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
  selectedAgent: string;
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
      selectedAgent: 'AgentB',
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
      selectedAgent: 'AgentB',
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
      selectedAgent: 'AgentB',
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
      selectedAgent: 'AgentA',
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
});
