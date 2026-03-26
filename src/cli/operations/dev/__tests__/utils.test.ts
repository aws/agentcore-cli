import {
  convertEntrypointToModule,
  findAvailablePort,
  formatMcpToolList,
  getEndpointUrl,
  isConnectionError,
  sleep,
  waitForPort,
} from '../utils.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Track which port should be available. createServer returns a fresh mock
 * each time, and the listen/on behavior is determined by whether the port
 * passed to listen matches the "available" set.
 */
const availablePorts = new Set<number>();

const { mockCreateServer } = vi.hoisted(() => {
  const mockCreateServer = vi.fn(() => {
    let errorHandler: (() => void) | null = null;

    const server = {
      listen: vi.fn((port: number, _host: string, cb: () => void) => {
        // Use queueMicrotask so that on('error') has time to register first
        queueMicrotask(() => {
          if (availablePorts.has(port)) {
            cb();
          } else if (errorHandler) {
            errorHandler();
          }
        });
      }),
      close: vi.fn((cb: () => void) => {
        cb();
      }),
      on: vi.fn((event: string, cb: () => void) => {
        if (event === 'error') {
          errorHandler = cb;
        }
      }),
    };

    return server;
  });
  return { mockCreateServer };
});

vi.mock('net', () => ({
  createServer: mockCreateServer,
}));

afterEach(() => {
  vi.clearAllMocks();
  availablePorts.clear();
});

describe('convertEntrypointToModule', () => {
  it('returns input unchanged when it already contains a colon', () => {
    expect(convertEntrypointToModule('app.main:handler')).toBe('app.main:handler');
  });

  it('strips .py and replaces / with . then appends :app', () => {
    expect(convertEntrypointToModule('main.py')).toBe('main:app');
  });

  it('handles nested path', () => {
    expect(convertEntrypointToModule('src/agents/main.py')).toBe('src.agents.main:app');
  });

  it('handles path without .py extension', () => {
    expect(convertEntrypointToModule('src/app')).toBe('src.app:app');
  });

  it('handles simple name without extension', () => {
    expect(convertEntrypointToModule('main')).toBe('main:app');
  });
});

describe('findAvailablePort', () => {
  it('returns startPort when it is available', async () => {
    availablePorts.add(3000);
    const port = await findAvailablePort(3000);
    expect(port).toBe(3000);
  });

  it('increments until finding an available port', async () => {
    // Only port 3002 is available; 3000 and 3001 are occupied
    availablePorts.add(3002);
    const port = await findAvailablePort(3000);
    expect(port).toBe(3002);
  });
});

describe('waitForPort', () => {
  it('returns true when port is immediately available', async () => {
    availablePorts.add(4000);
    const result = await waitForPort(4000, 1000);
    expect(result).toBe(true);
  });

  it('returns false when port never becomes available within timeout', async () => {
    // Port 4000 is never added to availablePorts, so it stays unavailable
    const result = await waitForPort(4000, 200);
    expect(result).toBe(false);
  });
});

describe('getEndpointUrl', () => {
  it('returns /mcp for MCP protocol', () => {
    expect(getEndpointUrl(8000, 'MCP')).toBe('http://localhost:8000/mcp');
  });

  it('returns / for A2A protocol', () => {
    expect(getEndpointUrl(9000, 'A2A')).toBe('http://localhost:9000/');
  });

  it('returns /invocations for HTTP protocol', () => {
    expect(getEndpointUrl(8080, 'HTTP')).toBe('http://localhost:8080/invocations');
  });

  it('returns /invocations for unknown protocol', () => {
    expect(getEndpointUrl(8080, 'UNKNOWN')).toBe('http://localhost:8080/invocations');
  });
});

describe('formatMcpToolList', () => {
  it('formats tools with descriptions and params', () => {
    const tools = [
      {
        name: 'add',
        description: 'Add numbers',
        inputSchema: { properties: { a: { type: 'integer' }, b: { type: 'integer' } } },
      },
      { name: 'greet', description: 'Say hello' },
    ];
    const result = formatMcpToolList(tools);
    expect(result).toContain('Available tools (2)');
    expect(result).toContain('add(a: integer, b: integer) - Add numbers');
    expect(result).toContain('greet() - Say hello');
    expect(result).toContain('Type: tool_name');
  });

  it('handles tools with no description', () => {
    const tools = [{ name: 'test' }];
    const result = formatMcpToolList(tools);
    expect(result).toContain('test()');
    expect(result).not.toContain(' - ');
  });

  it('handles empty tool list', () => {
    const result = formatMcpToolList([]);
    expect(result).toContain('Available tools (0)');
  });
});

describe('isConnectionError', () => {
  it('detects ECONNREFUSED', () => {
    expect(isConnectionError(new Error('connect ECONNREFUSED 127.0.0.1:8080'))).toBe(true);
  });

  it('detects fetch failed', () => {
    expect(isConnectionError(new Error('fetch failed'))).toBe(true);
  });

  it('does not match arbitrary errors', () => {
    expect(isConnectionError(new Error('timeout'))).toBe(false);
  });

  it('does not match partial "fetch" in other messages', () => {
    expect(isConnectionError(new Error('failed to fetch data from API'))).toBe(false);
  });
});

describe('sleep', () => {
  it('resolves after specified delay', async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});
