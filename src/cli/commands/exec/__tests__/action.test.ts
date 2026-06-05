import type { ConfigIO } from '../../../../lib/index.js';
import type { ExecuteBashStreamEvent } from '../../../aws/agentcore.js';
import { executeBashCommand } from '../../../aws/agentcore.js';
import { connectShell, startKeepalive } from '../../../aws/connect-shell.js';
import { handleExecOneShot, handleShellSession, loadExecContext } from '../action.js';
import type { ExecContext } from '../action.js';
import type { ExecOptions } from '../types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../aws/agentcore.js', () => ({
  executeBashCommand: vi.fn(),
}));

vi.mock('../../../aws/connect-shell.js', () => ({
  connectShell: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  startKeepalive: vi.fn(() => () => {}),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CTX: ExecContext = {
  region: 'us-east-1',
  runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/my-agent',
};

// eslint-disable-next-line @typescript-eslint/require-await
async function* makeStream(events: ExecuteBashStreamEvent[]): AsyncGenerator<ExecuteBashStreamEvent, void, unknown> {
  for (const event of events) {
    yield event;
  }
}

// ---------------------------------------------------------------------------
// Gap 6 — handleExecOneShot
// ---------------------------------------------------------------------------

describe('handleExecOneShot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns { success: true } when stream yields stop with exitCode 0', async () => {
    vi.mocked(executeBashCommand).mockResolvedValue({
      stream: makeStream([
        { type: 'stdout', data: 'hello\n' },
        { type: 'stop', exitCode: 0 },
      ]),
      sessionId: undefined,
    });

    const options: ExecOptions = { command: ['echo', 'hello'] };
    const result = await handleExecOneShot(CTX, options);
    expect(result.success).toBe(true);
  });

  it('returns { success: false } when stream yields stop with exitCode 1', async () => {
    vi.mocked(executeBashCommand).mockResolvedValue({
      stream: makeStream([{ type: 'stop', exitCode: 1 }]),
      sessionId: undefined,
    });

    const options: ExecOptions = { command: ['false'] };
    const result = await handleExecOneShot(CTX, options);
    expect(result.success).toBe(false);
  });

  it('returns { success: false, error: /without exit code/ } when stream ends without stop event', async () => {
    vi.mocked(executeBashCommand).mockResolvedValue({
      stream: makeStream([{ type: 'stdout', data: 'partial output' }]),
      sessionId: undefined,
    });

    const options: ExecOptions = { command: ['truncated'] };
    const result = await handleExecOneShot(CTX, options);
    expect(result.success).toBe(false);
    expect(!result.success && result.error?.message).toMatch(/without exit code/);
  });

  it('returns { success: false, error: /timed out/ } when timeout elapses before stream completes', async () => {
    vi.useFakeTimers();

    // Stream that never resolves — simulates a long-running command with no output
    let resolveNext: (() => void) | undefined;
    const neverEndingStream = (async function* () {
      await new Promise<void>(r => {
        resolveNext = r;
      });
      yield { type: 'stop' as const, exitCode: 0 };
    })();

    vi.mocked(executeBashCommand).mockResolvedValue({
      stream: neverEndingStream,
      sessionId: undefined,
    });

    const options: ExecOptions = { command: ['sleep', '100'], timeout: 5 };
    const resultPromise = handleExecOneShot(CTX, options);

    // Advance timers past the 5s timeout
    await vi.advanceTimersByTimeAsync(6000);

    const result = await resultPromise;
    resolveNext?.();

    vi.useRealTimers();

    expect(result.success).toBe(false);
    expect(!result.success && result.error?.message).toMatch(/timed out after 5s/);
  });

  it('returns { success: false, error: /timed out/ } when server kills with exitCode -1 and timeout is set', async () => {
    // Simulates the real-world path: server receives timeout, kills the process,
    // and emits a stop event with exitCode -1 before the client-side sentinel fires.
    vi.mocked(executeBashCommand).mockResolvedValue({
      stream: makeStream([{ type: 'stop', exitCode: -1 }]),
      sessionId: undefined,
    });

    const options: ExecOptions = { command: ['sleep', '100'], timeout: 2 };
    const result = await handleExecOneShot(CTX, options);

    expect(result.success).toBe(false);
    expect(!result.success && result.error?.message).toMatch(/timed out after 2s/);
    expect(result.exitCode).toBeUndefined(); // -1 is dropped; caller uses exit code 1
  });

  it('returns { success: false, error: /code -1/ } when server sends exitCode -1 without a timeout set', async () => {
    // exitCode -1 from the server without a client-side timeout means a genuine crash,
    // not a timeout. Should NOT produce a "timed out" message.
    vi.mocked(executeBashCommand).mockResolvedValue({
      stream: makeStream([{ type: 'stop', exitCode: -1 }]),
      sessionId: undefined,
    });

    const options: ExecOptions = { command: ['crash'] };
    const result = await handleExecOneShot(CTX, options);

    expect(result.success).toBe(false);
    expect(!result.success && result.error?.message).toMatch(/code -1/);
    expect(!result.success && result.error?.message).not.toMatch(/timed out/);
  });

  it('returns { success: false, error: /timed out/ } when server sends stop with status TIMED_OUT', async () => {
    vi.mocked(executeBashCommand).mockResolvedValue({
      stream: makeStream([{ type: 'stop', exitCode: 0, status: 'TIMED_OUT' }]),
      sessionId: undefined,
    });

    const options: ExecOptions = { command: ['sleep', '100'], timeout: 3 };
    const result = await handleExecOneShot(CTX, options);

    expect(result.success).toBe(false);
    expect(!result.success && result.error?.message).toMatch(/timed out after 3s/);
  });

  it('timeout: 0 is treated as no timeout', async () => {
    vi.mocked(executeBashCommand).mockResolvedValue({
      stream: makeStream([
        { type: 'stdout', data: 'hello\n' },
        { type: 'stop', exitCode: 0 },
      ]),
      sessionId: undefined,
    });

    const options: ExecOptions = { command: ['echo', 'hello'], timeout: 0 };
    const result = await handleExecOneShot(CTX, options);

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('returns error when no command provided', async () => {
    const options: ExecOptions = {};
    const result = await handleExecOneShot(CTX, options);
    expect(result.success).toBe(false);
    expect(!result.success && result.error?.message).toMatch(/No command/);
  });
});

// ---------------------------------------------------------------------------
// Gap 8 — handleShellSession UX banner messages
// ---------------------------------------------------------------------------

describe('handleShellSession banner messages', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let mockWs: {
    on: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    readyState: number;
    OPEN: number;
    removeAllListeners: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Build a minimal WS mock that captures event handlers so we can drive them manually
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    mockWs = {
      readyState: 1,
      OPEN: 1,
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(fn);
      }),
      once: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(fn);
      }),
      send: vi.fn(),
      // close() fires close handlers (so handlers like ws.on('close', ...) in handleShellSession work)
      close: vi.fn(() => {
        handlers.close?.forEach(fn => fn());
      }),
      terminate: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    // Expose a helper to fire ws events
    (mockWs as unknown as { _fire: (e: string, ...a: unknown[]) => void })._fire = (
      event: string,
      ...args: unknown[]
    ) => {
      handlers[event]?.forEach(fn => fn(...args));
    };

    vi.mocked(connectShell).mockResolvedValue({
      ws: mockWs as unknown as import('ws').default,
      shellId: 'test-shell-id',
      reconnected: false,
    });

    // eslint-disable-next-line @typescript-eslint/no-empty-function
    vi.mocked(startKeepalive).mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes "Connecting to agent VM..." before connection', async () => {
    const options: ExecOptions = {
      runtimeArn: CTX.runtimeArn,
      region: CTX.region,
    };

    // We need to intercept the WS close event to resolve the session
    vi.mocked(connectShell).mockImplementation(() => {
      // Verify banner was already written before connectShell resolves
      const stderrCalls = (stderrSpy.mock.calls as [string][]).map(c => c[0]);
      expect(stderrCalls.some(msg => msg.includes('Connecting to agent VM...'))).toBe(true);
      return Promise.resolve({
        ws: mockWs as unknown as import('ws').default,
        shellId: 'test-shell-id',
        reconnected: false,
      });
    });

    // Kick off session in background; it won't resolve until ws close fires
    const sessionPromise = handleShellSession(CTX, options);

    // Wait for connectShell to have been called and handlers attached
    await new Promise(r => setTimeout(r, 0));

    // Fire WS close to end the session
    (mockWs as unknown as { _fire: (e: string, ...a: unknown[]) => void })._fire('close', 0);

    await sessionPromise;
  });

  it('writes "[connected · session ...]" banner after connection', async () => {
    const options: ExecOptions = {
      runtimeArn: CTX.runtimeArn,
      region: CTX.region,
    };

    const sessionPromise = handleShellSession(CTX, options);

    await new Promise(r => setTimeout(r, 0));

    // Connected banner should be written by now
    const stderrCalls = (stderrSpy.mock.calls as [string][]).map(c => c[0]);
    expect(stderrCalls.some(msg => msg.includes('[connected') && msg.includes('session'))).toBe(true);

    (mockWs as unknown as { _fire: (e: string, ...a: unknown[]) => void })._fire('close', 0);
    await sessionPromise;
  });

  it('writes "[session closed · exit 0]" after clean WS close', async () => {
    const options: ExecOptions = {
      runtimeArn: CTX.runtimeArn,
      region: CTX.region,
    };

    const sessionPromise = handleShellSession(CTX, options);
    await new Promise(r => setTimeout(r, 0));

    // Send a STATUS termination frame with exitCode=0 — action.ts sets exitCode=0 then calls ws.close(),
    // which in our mock fires the 'close' handler, triggering cleanup(0) and the banner write.
    const terminationPayload = JSON.stringify({
      kind: 'Status',
      metadata: {},
      status: 'Success',
      details: { causes: [{ reason: 'ExitCode', message: '0' }] },
    });
    const { ShellChannel: SC } = await import('../../../aws/shell-framer.js');
    const terminationFrame = Buffer.concat([Buffer.from([SC.STATUS]), Buffer.from(terminationPayload)]);
    (mockWs as unknown as { _fire: (e: string, ...a: unknown[]) => void })._fire('message', terminationFrame);

    const result = await sessionPromise;

    const stderrCalls = (stderrSpy.mock.calls as [string][]).map(c => c[0]);
    expect(stderrCalls.some(msg => msg.includes('[session closed · exit 0]'))).toBe(true);
    expect(result.success).toBe(true);
  });

  it('writes "[info] Previous shell session has ended..." when shellId passed but reconnected=false', async () => {
    vi.mocked(connectShell).mockResolvedValue({
      ws: mockWs as unknown as import('ws').default,
      shellId: 'new-shell-id',
      reconnected: false,
    });

    const options: ExecOptions = {
      runtimeArn: CTX.runtimeArn,
      region: CTX.region,
      shellId: 'old-shell-id',
    };

    const sessionPromise = handleShellSession(CTX, options);
    await new Promise(r => setTimeout(r, 0));

    const stderrCalls = (stderrSpy.mock.calls as [string][]).map(c => c[0]);
    expect(stderrCalls.some(msg => msg.includes('[info]') && msg.includes('Previous shell session has ended'))).toBe(
      true
    );

    (mockWs as unknown as { _fire: (e: string, ...a: unknown[]) => void })._fire('close', 0);
    await sessionPromise;
  });
});

// ---------------------------------------------------------------------------
// CLOSE (0xFF) frame handling
// ---------------------------------------------------------------------------

describe('handleShellSession CLOSE frame (0xFF)', () => {
  let mockWs: Record<string, unknown>;
  let fire: (event: string, ...args: unknown[]) => void;

  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    fire = (event, ...args) => handlers[event]?.forEach(fn => fn(...args));

    mockWs = {
      readyState: 1,
      OPEN: 1,
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(fn);
      }),
      once: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(fn);
      }),
      send: vi.fn(),
      close: vi.fn(() => fire('close')),
      terminate: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(connectShell).mockResolvedValue({
      ws: mockWs as unknown as import('ws').default,
      shellId: 'shell-abc',
      reconnected: false,
    });
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    vi.mocked(startKeepalive).mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('CLOSE (0xFF) frame causes ws.close() to be called', async () => {
    const options: ExecOptions = { runtimeArn: CTX.runtimeArn, region: CTX.region };
    const sessionPromise = handleShellSession(CTX, options);
    await new Promise(r => setTimeout(r, 0));

    const { ShellChannel: SC } = await import('../../../aws/shell-framer.js');
    const closeFrame = Buffer.from([SC.CLOSE]);
    fire('message', closeFrame);

    await sessionPromise;
    expect(vi.mocked(mockWs.close as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Unknown channel — silently ignored
// ---------------------------------------------------------------------------

describe('handleShellSession unknown channel byte', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let mockWs: Record<string, unknown>;
  let fire: (event: string, ...args: unknown[]) => void;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    fire = (event, ...args) => handlers[event]?.forEach(fn => fn(...args));

    mockWs = {
      readyState: 1,
      OPEN: 1,
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(fn);
      }),
      once: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(fn);
      }),
      send: vi.fn(),
      close: vi.fn(() => fire('close')),
      terminate: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(connectShell).mockResolvedValue({
      ws: mockWs as unknown as import('ws').default,
      shellId: 'shell-xyz',
      reconnected: false,
    });
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    vi.mocked(startKeepalive).mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('unknown channel byte (0x42) does not write to stdout or stderr', async () => {
    const options: ExecOptions = { runtimeArn: CTX.runtimeArn, region: CTX.region };
    const sessionPromise = handleShellSession(CTX, options);
    await new Promise(r => setTimeout(r, 0));

    // Clear banner writes so we can check only data-driven writes
    stdoutSpy.mockClear();
    stderrSpy.mockClear();

    const unknownFrame = Buffer.concat([Buffer.from([0x42]), Buffer.from('future-data')]);
    fire('message', unknownFrame);

    // Verify no data was written as a result of the unknown frame
    expect(stdoutSpy).not.toHaveBeenCalled();
    // stderr may get writes from unrelated paths; check it wasn't called with frame data
    const stderrData = (stderrSpy.mock.calls as [string][]).map(c => c[0]);
    expect(stderrData.every(s => !s.includes('future-data'))).toBe(true);

    fire('close');
    await sessionPromise;
  });
});

// ---------------------------------------------------------------------------
// startKeepalive integration in handleShellSession
// ---------------------------------------------------------------------------

describe('handleShellSession startKeepalive integration', () => {
  let mockWs: Record<string, unknown>;
  let fire: (event: string, ...args: unknown[]) => void;
  let stopKeepalive: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    fire = (event, ...args) => handlers[event]?.forEach(fn => fn(...args));

    mockWs = {
      readyState: 1,
      OPEN: 1,
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(fn);
      }),
      once: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(fn);
      }),
      send: vi.fn(),
      close: vi.fn(() => fire('close')),
      terminate: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(connectShell).mockResolvedValue({
      ws: mockWs as unknown as import('ws').default,
      shellId: 'shell-keep',
      reconnected: false,
    });

    stopKeepalive = vi.fn();
    vi.mocked(startKeepalive).mockReturnValue(stopKeepalive as unknown as () => void);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls startKeepalive once after connection', async () => {
    const options: ExecOptions = { runtimeArn: CTX.runtimeArn, region: CTX.region };
    const sessionPromise = handleShellSession(CTX, options);
    await new Promise(r => setTimeout(r, 0));

    expect(startKeepalive).toHaveBeenCalledOnce();
    expect(startKeepalive).toHaveBeenCalledWith(mockWs, expect.any(Function));

    fire('close');
    await sessionPromise;
  });

  it('calls stopKeepalive during cleanup', async () => {
    const options: ExecOptions = { runtimeArn: CTX.runtimeArn, region: CTX.region };
    const sessionPromise = handleShellSession(CTX, options);
    await new Promise(r => setTimeout(r, 0));

    fire('close');
    await sessionPromise;

    expect(stopKeepalive).toHaveBeenCalled();
  });

  it('keepalive onDead terminates the ws', async () => {
    const options: ExecOptions = { runtimeArn: CTX.runtimeArn, region: CTX.region };
    const sessionPromise = handleShellSession(CTX, options);
    await new Promise(r => setTimeout(r, 0));

    // Grab the onDead callback passed to startKeepalive and invoke it
    const onDead = vi.mocked(startKeepalive).mock.calls[0]![1];
    onDead();

    expect(vi.mocked(mockWs.terminate as ReturnType<typeof vi.fn>)).toHaveBeenCalled();

    fire('close');
    await sessionPromise;
  });
});

// ---------------------------------------------------------------------------
// Reconnect callbacks wired through handleShellSession
// ---------------------------------------------------------------------------

describe('handleShellSession reconnect callbacks wired to connectShell', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    vi.mocked(startKeepalive).mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes reconnect.onAttempt to connectShell and it writes the disconnected message', async () => {
    let capturedOnAttempt: ((attempt: number, reason: string) => void) | undefined;
    let capturedWs: ReturnType<typeof makeMockWsForCallbacks> | undefined;

    vi.mocked(connectShell).mockImplementation(opts => {
      capturedOnAttempt = opts.reconnect?.onAttempt;
      capturedWs = makeMockWsForCallbacks();
      return Promise.resolve({ ws: capturedWs, shellId: 'shell-ra', reconnected: false });
    });

    const options: ExecOptions = { runtimeArn: CTX.runtimeArn, region: CTX.region };
    const sessionPromise = handleShellSession(CTX, options);
    await new Promise(r => setTimeout(r, 0));

    capturedOnAttempt?.(2, 'network drop');

    const stderrData = (stderrSpy.mock.calls as [string][]).map(c => c[0]);
    expect(stderrData.some(s => s.includes('reconnecting (2/5)'))).toBe(true);

    (capturedWs as unknown as { _fire: (e: string) => void })._fire('close');
    await sessionPromise;
  });

  it('passes reconnect.onKicked to connectShell and it writes the kicked message', async () => {
    let capturedOnKicked: (() => void) | undefined;
    let capturedWs: ReturnType<typeof makeMockWsForCallbacks> | undefined;

    vi.mocked(connectShell).mockImplementation(opts => {
      capturedOnKicked = opts.reconnect?.onKicked;
      capturedWs = makeMockWsForCallbacks();
      return Promise.resolve({ ws: capturedWs, shellId: 'shell-kick', reconnected: false });
    });

    const options: ExecOptions = { runtimeArn: CTX.runtimeArn, region: CTX.region };
    const sessionPromise = handleShellSession(CTX, options);
    await new Promise(r => setTimeout(r, 0));

    capturedOnKicked?.();
    const stderrData = (stderrSpy.mock.calls as [string][]).map(c => c[0]);
    expect(stderrData.some(s => s.includes('session attached from another client'))).toBe(true);

    (capturedWs as unknown as { _fire: (e: string) => void })._fire('close');
    await sessionPromise;
  });

  it('tracks wasKicked=true in ExecResult when onKicked fires', async () => {
    let capturedOnKicked: (() => void) | undefined;
    let capturedWs: ReturnType<typeof makeMockWsForCallbacks> | undefined;

    vi.mocked(connectShell).mockImplementation(opts => {
      capturedOnKicked = opts.reconnect?.onKicked;
      capturedWs = makeMockWsForCallbacks();
      return Promise.resolve({ ws: capturedWs, shellId: 'shell-kick2', reconnected: false });
    });

    const options: ExecOptions = { runtimeArn: CTX.runtimeArn, region: CTX.region };
    const sessionPromise = handleShellSession(CTX, options);
    await new Promise(r => setTimeout(r, 0));

    capturedOnKicked?.();
    (capturedWs as unknown as { _fire: (e: string) => void })._fire('close');
    const result = await sessionPromise;

    expect(result.wasKicked).toBe(true);
  });

  it('tracks reconnectAttempts in ExecResult when onAttempt fires', async () => {
    let capturedOnAttempt: ((attempt: number, reason: string) => void) | undefined;
    let capturedWs: ReturnType<typeof makeMockWsForCallbacks> | undefined;

    vi.mocked(connectShell).mockImplementation(opts => {
      capturedOnAttempt = opts.reconnect?.onAttempt;
      capturedWs = makeMockWsForCallbacks();
      return Promise.resolve({ ws: capturedWs, shellId: 'shell-ra2', reconnected: false });
    });

    const options: ExecOptions = { runtimeArn: CTX.runtimeArn, region: CTX.region };
    const sessionPromise = handleShellSession(CTX, options);
    await new Promise(r => setTimeout(r, 0));

    capturedOnAttempt?.(3, 'network drop');
    (capturedWs as unknown as { _fire: (e: string) => void })._fire('close');
    const result = await sessionPromise;

    expect(result.reconnectAttempts).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// loadExecContext with targetName
// ---------------------------------------------------------------------------

describe('loadExecContext with targetName', () => {
  it('throws with available targets listed when targetName not found', async () => {
    const mockConfigIO = {
      readAWSDeploymentTargets: vi.fn().mockResolvedValue([
        { name: 'prod', region: 'us-east-1' },
        { name: 'staging', region: 'us-west-2' },
      ]),
      readDeployedState: vi.fn().mockResolvedValue({
        targets: {
          prod: {
            resources: {
              runtimes: { 'my-agent': { runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r' } },
            },
          },
          staging: {
            resources: {
              runtimes: { 'my-agent': { runtimeArn: 'arn:aws:bedrock-agentcore:us-west-2:123:runtime/r' } },
            },
          },
        },
      }),
    } as unknown as ConfigIO;

    await expect(loadExecContext({ targetName: 'nonexistent' }, mockConfigIO)).rejects.toThrow(
      /nonexistent.*prod.*staging|prod.*staging.*nonexistent/i
    );
  });

  it('selects the named target when targetName is valid', async () => {
    const mockConfigIO = {
      readAWSDeploymentTargets: vi.fn().mockResolvedValue([
        { name: 'prod', region: 'us-east-1' },
        { name: 'staging', region: 'us-west-2' },
      ]),
      readDeployedState: vi.fn().mockResolvedValue({
        targets: {
          prod: { resources: { runtimes: { 'my-agent': { runtimeArn: 'arn:prod' } } } },
          staging: { resources: { runtimes: { 'my-agent': { runtimeArn: 'arn:staging' } } } },
        },
      }),
    } as unknown as ConfigIO;

    const ctx = await loadExecContext({ targetName: 'staging' }, mockConfigIO);
    expect(ctx.region).toBe('us-west-2');
    expect(ctx.runtimeArn).toBe('arn:staging');
  });
});

// ---------------------------------------------------------------------------
// loadExecContext — --runtime as ARN vs name
// ---------------------------------------------------------------------------

describe('loadExecContext --runtime as ARN or name', () => {
  const TWO_AGENT_CONFIG = {
    readAWSDeploymentTargets: vi.fn().mockResolvedValue([{ name: 'default', region: 'us-east-1' }]),
    readDeployedState: vi.fn().mockResolvedValue({
      targets: {
        default: {
          resources: {
            runtimes: {
              AgentA: { runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/AgentA' },
              AgentB: { runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/AgentB' },
            },
          },
        },
      },
    }),
  } as unknown as ConfigIO;

  const ONE_AGENT_CONFIG = {
    readAWSDeploymentTargets: vi.fn().mockResolvedValue([{ name: 'default', region: 'us-east-1' }]),
    readDeployedState: vi.fn().mockResolvedValue({
      targets: {
        default: {
          resources: {
            runtimes: {
              AgentA: { runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/AgentA' },
            },
          },
        },
      },
    }),
  } as unknown as ConfigIO;

  it('short-circuits when --runtime is a full ARN and --region is provided', async () => {
    const ctx = await loadExecContext(
      { runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/X', region: 'us-west-2' },
      TWO_AGENT_CONFIG
    );
    // Region from CLI flag, not config
    expect(ctx.region).toBe('us-west-2');
    expect(ctx.runtimeArn).toBe('arn:aws:bedrock-agentcore:us-east-1:123:runtime/X');
    // Config should not be read at all
    expect(
      (TWO_AGENT_CONFIG as unknown as { readAWSDeploymentTargets: ReturnType<typeof vi.fn> }).readAWSDeploymentTargets
    ).not.toHaveBeenCalled();
  });

  it('resolves region from config when --runtime is a full ARN but --region is omitted', async () => {
    const ctx = await loadExecContext(
      { runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/X' },
      TWO_AGENT_CONFIG
    );
    expect(ctx.region).toBe('us-east-1'); // from config
    expect(ctx.runtimeArn).toBe('arn:aws:bedrock-agentcore:us-east-1:123:runtime/X');
  });

  it('resolves runtimeArn when --runtime is an agent name', async () => {
    const ctx = await loadExecContext({ runtimeArn: 'AgentB' }, TWO_AGENT_CONFIG);
    expect(ctx.runtimeArn).toBe('arn:aws:bedrock-agentcore:us-east-1:123:runtime/AgentB');
    expect(ctx.region).toBe('us-east-1');
  });

  it('throws with available agents listed when --runtime name is not found', async () => {
    await expect(loadExecContext({ runtimeArn: 'AgentC' }, TWO_AGENT_CONFIG)).rejects.toThrow(
      /AgentC.*AgentA.*AgentB|AgentC.*AgentB.*AgentA/
    );
  });

  it('throws when no --runtime and multiple agents are deployed', async () => {
    await expect(loadExecContext({}, TWO_AGENT_CONFIG)).rejects.toThrow(
      /Multiple agents.*AgentA.*AgentB|Multiple agents.*AgentB.*AgentA/
    );
  });

  it('auto-selects when no --runtime and exactly one agent is deployed', async () => {
    const ctx = await loadExecContext({}, ONE_AGENT_CONFIG);
    expect(ctx.runtimeArn).toBe('arn:aws:bedrock-agentcore:us-east-1:123:runtime/AgentA');
  });
});

// ---------------------------------------------------------------------------
// handleExecOneShot — --json buffering
// ---------------------------------------------------------------------------

describe('handleExecOneShot --json mode', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('buffers stdout/stderr and returns them in the result on success', async () => {
    vi.mocked(executeBashCommand).mockResolvedValue({
      stream: makeStream([
        { type: 'stdout', data: 'hello\n' },
        { type: 'stderr', data: 'warn\n' },
        { type: 'stop', exitCode: 0 },
      ]),
      sessionId: undefined,
    });

    const result = await handleExecOneShot(CTX, { command: ['echo', 'hello'], json: true });
    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello\n');
    expect(result.stderr).toBe('warn\n');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('returns stdout/stderr in result with success:false on non-zero exit', async () => {
    vi.mocked(executeBashCommand).mockResolvedValue({
      stream: makeStream([
        { type: 'stdout', data: 'out\n' },
        { type: 'stop', exitCode: 2 },
      ]),
      sessionId: undefined,
    });

    const result = await handleExecOneShot(CTX, { command: ['false'], json: true });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('out\n');
    expect(result.stderr).toBe('');
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it('does NOT write raw bytes to stdout in json mode', async () => {
    vi.mocked(executeBashCommand).mockResolvedValue({
      stream: makeStream([
        { type: 'stdout', data: 'raw-output' },
        { type: 'stop', exitCode: 0 },
      ]),
      sessionId: undefined,
    });

    await handleExecOneShot(CTX, { command: ['echo'], json: true });

    // All stdout writes should be valid JSON — none should be the raw 'raw-output' string
    const rawWrites = (stdoutSpy.mock.calls as [unknown][]).map(c => String(c[0])).filter(s => s === 'raw-output');
    expect(rawWrites).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleShellSession — WS close code 1000 without STATUS frame treated as clean exit
// ---------------------------------------------------------------------------

describe('handleShellSession WS close code 1000 → clean exit', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let mockWs: Record<string, unknown>;
  let fire: (event: string, ...args: unknown[]) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    fire = (event, ...args) => handlers[event]?.forEach(fn => fn(...args));

    mockWs = {
      readyState: 1,
      OPEN: 1,
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(fn);
      }),
      once: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(fn);
      }),
      send: vi.fn(),
      close: vi.fn(() => fire('close', 1000)),
      terminate: vi.fn(),
      removeAllListeners: vi.fn(),
    };

    vi.mocked(connectShell).mockResolvedValue({
      ws: mockWs as unknown as import('ws').default,
      shellId: 'shell-1000',
      reconnected: false,
    });
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    vi.mocked(startKeepalive).mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves success:true when WS closes with code 1000 and no STATUS frame', async () => {
    const options: ExecOptions = { runtimeArn: CTX.runtimeArn, region: CTX.region };
    const sessionPromise = handleShellSession(CTX, options);
    await new Promise(r => setTimeout(r, 0));

    // Fire close with code 1000 — no STATUS termination frame sent (the `exit` scenario)
    fire('close', 1000);
    const result = await sessionPromise;

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('does NOT write reconnect hint on clean exit (WS closes with code 1000)', async () => {
    const options: ExecOptions = { runtimeArn: CTX.runtimeArn, region: CTX.region };
    const sessionPromise = handleShellSession(CTX, options);
    await new Promise(r => setTimeout(r, 0));

    fire('close', 1000);
    await sessionPromise;

    const stderrData = (stderrSpy.mock.calls as [unknown][]).map(c => String(c[0])).join('');
    expect(stderrData).not.toMatch(/to reconnect/);
    expect(stderrData).not.toMatch(/disconnected/);
  });

  it('resolves success:true with exitCode 0 when WS closes with code 1006 and no STATUS frame', async () => {
    // connectShell only resolves after STATUS confirmation, so any WS close without a STATUS
    // termination frame (any close code) is treated as exit 0 — the shell ran to completion;
    // the server just didn't send a termination frame.
    const handlers2: Record<string, ((...args: unknown[]) => void)[]> = {};
    const fire2 = (event: string, ...args: unknown[]) => handlers2[event]?.forEach(fn => fn(...args));
    const mockWs2 = {
      readyState: 1,
      OPEN: 1,
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        (handlers2[event] ??= []).push(fn);
      }),
      once: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        (handlers2[event] ??= []).push(fn);
      }),
      send: vi.fn(),
      close: vi.fn(() => fire2('close', 1006)),
      terminate: vi.fn(),
      removeAllListeners: vi.fn(),
    };
    vi.mocked(connectShell).mockResolvedValue({
      ws: mockWs2 as unknown as import('ws').default,
      shellId: 'shell-1006',
      reconnected: false,
    });

    const options: ExecOptions = { runtimeArn: CTX.runtimeArn, region: CTX.region };
    const sessionPromise = handleShellSession(CTX, options);
    await new Promise(r => setTimeout(r, 0));

    fire2('close', 1006);
    const result = await sessionPromise;

    expect(result.success).toBe(true);
    // exitCode is 0: session confirmed, no STATUS termination frame → treated as clean exit
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// handleShellSession — reconnect hint uses flag-per-line format
// ---------------------------------------------------------------------------

describe('handleShellSession reconnect hint format', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    vi.mocked(startKeepalive).mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints reconnect hint with flag-per-line format after Ctrl+] detach', async () => {
    // Reconnect hint is only shown on Ctrl+] detach (detached=true) or true network drops
    // (where connectShell itself throws, not via the ws.on('close') path).
    // Simulate detach by sending Ctrl+] (0x1d) via stdin data event.
    const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    const fire = (event: string, ...args: unknown[]) => handlers[event]?.forEach(fn => fn(...args));
    const mockWs2 = {
      readyState: 1,
      OPEN: 1,
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(fn);
      }),
      once: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(fn);
      }),
      send: vi.fn(),
      // close() sends WS close code 1000 (normal detach-initiated close)
      close: vi.fn(() => fire('close', 1000)),
      terminate: vi.fn(),
      removeAllListeners: vi.fn(),
    };
    vi.mocked(connectShell).mockResolvedValue({
      ws: mockWs2 as unknown as import('ws').default,
      shellId: 'shell-hint',
      reconnected: false,
    });

    const stdinHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};
    vi.spyOn(process.stdin, 'on').mockImplementation((event: string | symbol, fn: (...args: unknown[]) => void) => {
      (stdinHandlers[String(event)] ??= []).push(fn);
      return process.stdin;
    });

    const options: ExecOptions = { runtimeArn: CTX.runtimeArn, region: CTX.region };
    const sessionPromise = handleShellSession(CTX, options);
    await new Promise(r => setTimeout(r, 0));

    // Send Ctrl+] (0x1d) to trigger detach — this sets detached=true and calls ws.close()
    stdinHandlers.data?.forEach(fn => fn(Buffer.from([0x1d])));
    await sessionPromise;

    const stderrData = (stderrSpy.mock.calls as [unknown][]).map(c => String(c[0])).join('');
    // Should contain each flag on its own line
    expect(stderrData).toMatch(/--runtime/);
    expect(stderrData).toMatch(/--region/);
    expect(stderrData).toMatch(/--session-id/);
    expect(stderrData).toMatch(/--shell-id/);
    // Should use backslash continuation
    expect(stderrData).toMatch(/\\\n/);
  });
});

// ---------------------------------------------------------------------------
// Helpers shared by callback tests
// ---------------------------------------------------------------------------

function makeMockWsForCallbacks() {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const fire = (event: string, ...args: unknown[]) => handlers[event]?.forEach(fn => fn(...args));

  const ws = {
    readyState: 1,
    OPEN: 1,
    on: (event: string, fn: (...args: unknown[]) => void) => {
      (handlers[event] ??= []).push(fn);
    },
    once: (event: string, fn: (...args: unknown[]) => void) => {
      (handlers[event] ??= []).push(fn);
    },
    send: vi.fn(),
    close: vi.fn(() => fire('close')),
    terminate: vi.fn(),
    removeAllListeners: vi.fn(),
    _fire: fire,
  };
  return ws as unknown as import('ws').default;
}
