import { ShellKickedError } from '../../../lib/errors/types.js';
import { buildShellUrl, connectShell, startKeepalive } from '../connect-shell.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../account', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({
    accessKeyId: 'AKID',
    secretAccessKey: 'SECRET',
    sessionToken: 'TOKEN',
  }),
}));

// Hoisted so the vi.mock('ws') factory can reference them
const wsState = vi.hoisted(() => {
  return {
    calls: [] as string[],
    openHandler: undefined as (() => void) | undefined,
    closeHandler: undefined as ((code: number) => void) | undefined,
    errorHandler: undefined as ((err: Error) => void) | undefined,
    upgradeHandler: undefined as ((response: { headers: Record<string, string> }) => void) | undefined,
    terminateCalled: false,
    reset() {
      this.calls = [];
      this.openHandler = undefined;
      this.closeHandler = undefined;
      this.errorHandler = undefined;
      this.upgradeHandler = undefined;
      this.terminateCalled = false;
    },
  };
});

vi.mock('ws', () => ({
  default: class MockWebSocket {
    constructor(url: string) {
      wsState.calls.push(url);
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      if (event === 'open') wsState.openHandler = handler as () => void;
      if (event === 'close') wsState.closeHandler = handler as (code: number) => void;
      if (event === 'error') wsState.errorHandler = handler as (err: Error) => void;
      if (event === 'upgrade')
        wsState.upgradeHandler = handler as (response: { headers: Record<string, string> }) => void;
    }
    terminate() {
      wsState.terminateCalled = true;
    }
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    close() {}
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    send() {}
    get readyState() {
      return 1 as const;
    }
  },
}));

// ---------------------------------------------------------------------------
// buildShellUrl
// ---------------------------------------------------------------------------

describe('buildShellUrl', () => {
  afterEach(() => {
    delete process.env.AGENTCORE_STAGE;
  });

  it('generates wss:// URL with qualifier=DEFAULT (prod)', () => {
    const url = buildShellUrl('us-east-1', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/my-agent');
    expect(url.protocol).toBe('wss:');
    expect(url.hostname).toBe('bedrock-agentcore.us-east-1.amazonaws.com');
    expect(url.searchParams.get('qualifier')).toBe('DEFAULT');
  });

  it('uses beta endpoint when AGENTCORE_STAGE=beta', () => {
    process.env.AGENTCORE_STAGE = 'beta';
    const url = buildShellUrl('us-east-1', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r');
    expect(url.hostname).toBe('beta.us-east-1.elcapdp.genesis-primitives.aws.dev');
    expect(url.protocol).toBe('wss:');
  });

  it('uses gamma endpoint when AGENTCORE_STAGE=gamma', () => {
    process.env.AGENTCORE_STAGE = 'gamma';
    const url = buildShellUrl('us-east-1', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r');
    expect(url.hostname).toBe('gamma.us-east-1.elcapdp.genesis-primitives.aws.dev');
  });

  it('includes shellId query param when shellId provided', () => {
    const url = buildShellUrl('us-east-1', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r', 'my-shell');
    expect(url.searchParams.get('shellId')).toBe('my-shell');
  });

  it('omits shellId when shellId is absent', () => {
    const url = buildShellUrl('us-east-1', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r');
    expect(url.searchParams.has('shellId')).toBe(false);
  });

  it('URL-encodes the runtimeArn in the path', () => {
    const arn = 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/my-agent';
    const url = buildShellUrl('us-east-1', arn);
    expect(url.pathname).toContain(encodeURIComponent(arn));
  });
});

// ---------------------------------------------------------------------------
// connectShell — immediate connect (no confirmation frame wait)
// ---------------------------------------------------------------------------

describe('connectShell', () => {
  beforeEach(() => {
    wsState.reset();
  });

  it('resolves with shellId from X-Amzn-Bedrock-AgentCore-Shell-Id 101 header', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    await new Promise(r => setTimeout(r, 0));
    // Header fires first (101 upgrade), then open event
    wsState.upgradeHandler?.({ headers: { 'x-amzn-bedrock-agentcore-shell-id': 'header-shell-id' } });
    wsState.openHandler?.();

    const conn = await connectPromise;
    expect(conn.shellId).toBe('header-shell-id');
  });

  it('uses provided shellId as fallback when header is absent', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      shellId: 'my-fallback-shell',
    });

    await new Promise(r => setTimeout(r, 0));
    // No upgrade event — open fires without header
    wsState.openHandler?.();

    const conn = await connectPromise;
    expect(conn.shellId).toBe('my-fallback-shell');
  });

  it('fails when a new connection has no shell ID (no header and no provided shellId)', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      // No shellId provided (fresh connect) and the upgrade header never arrives, so there is no
      // usable shell ID. Resolving with '' would silently break reconnect — connect must fail.
    });

    await new Promise(r => setTimeout(r, 0));
    // No upgrade event fires — open arrives without a shell-id header.
    wsState.openHandler?.();

    await expect(connectPromise).rejects.toThrow(/did not return a shell ID/);
  });

  it('resolves immediately on open event (no confirmation frame needed)', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    await new Promise(r => setTimeout(r, 0));
    wsState.upgradeHandler?.({ headers: { 'x-amzn-bedrock-agentcore-shell-id': 'fast-shell' } });
    wsState.openHandler?.();

    const conn = await connectPromise;
    expect(conn.shellId).toBe('fast-shell');
  });

  it('does not have reconnected or bytesDropped on ShellConnection', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    await new Promise(r => setTimeout(r, 0));
    wsState.upgradeHandler?.({ headers: { 'x-amzn-bedrock-agentcore-shell-id': 'shell-1' } });
    wsState.openHandler?.();

    const conn = await connectPromise;
    expect(conn).not.toHaveProperty('reconnected');
    expect(conn).not.toHaveProperty('bytesDropped');
  });

  it('throws ShellKickedError when WS closes with code 4000', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    await new Promise(r => setTimeout(r, 0));
    wsState.closeHandler?.(4000);

    await expect(connectPromise).rejects.toThrow(ShellKickedError);
  });

  it('throws generic error when WS closes with non-4000 code before open', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    await new Promise(r => setTimeout(r, 0));
    wsState.closeHandler?.(1006);

    await expect(connectPromise).rejects.toThrow(/closed before open/);
  });

  it('throws on WS error before open', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    await new Promise(r => setTimeout(r, 0));
    wsState.errorHandler?.(new Error('ECONNREFUSED'));

    await expect(connectPromise).rejects.toThrow('ECONNREFUSED');
  });

  it('does not retry after ShellKickedError (close code 4000)', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      reconnect: { maxRetries: 5 },
    });

    await new Promise(r => setTimeout(r, 0));
    wsState.closeHandler?.(4000);

    await expect(connectPromise).rejects.toThrow(ShellKickedError);
    // Only one WS connection attempt — no retry for kick
    expect(wsState.calls).toHaveLength(1);
  });

  it('passes shellId as shellId query param on reconnect', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      shellId: 'reconnect-id',
    });

    await new Promise(r => setTimeout(r, 0));
    wsState.upgradeHandler?.({ headers: { 'x-amzn-bedrock-agentcore-shell-id': 'reconnect-id' } });
    wsState.openHandler?.();

    const conn = await connectPromise;
    expect(conn.shellId).toBe('reconnect-id');
    expect(wsState.calls[0]).toContain('shellId=reconnect-id');
  });
});

// ---------------------------------------------------------------------------
// AGENTCORE_STAGE case-insensitivity
// ---------------------------------------------------------------------------

describe('buildShellUrl AGENTCORE_STAGE case-insensitivity', () => {
  afterEach(() => {
    delete process.env.AGENTCORE_STAGE;
  });

  it('routes to beta when AGENTCORE_STAGE=BETA (uppercase)', () => {
    process.env.AGENTCORE_STAGE = 'BETA';
    const url = buildShellUrl('us-east-1', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r');
    expect(url.hostname).toContain('beta');
  });

  it('routes to gamma when AGENTCORE_STAGE=Gamma (mixed case)', () => {
    process.env.AGENTCORE_STAGE = 'Gamma';
    const url = buildShellUrl('us-east-1', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r');
    expect(url.hostname).toContain('gamma');
  });
});

// ---------------------------------------------------------------------------
// Partition-aware prod URL
// ---------------------------------------------------------------------------

describe('buildShellUrl partition-aware hostname', () => {
  afterEach(() => {
    delete process.env.AGENTCORE_STAGE;
  });

  it('uses serviceEndpoint contract for prod: hostname is bedrock-agentcore.<region>.amazonaws.com for us-east-1', () => {
    const url = buildShellUrl('us-east-1', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r');
    expect(url.hostname).toBe('bedrock-agentcore.us-east-1.amazonaws.com');
  });

  it('uses the region-specific DNS suffix for GovCloud (us-gov-west-1)', () => {
    const url = buildShellUrl('us-gov-west-1', 'arn:aws-us-gov:bedrock-agentcore:us-gov-west-1:123:runtime/r');
    expect(url.hostname).toBe('bedrock-agentcore.us-gov-west-1.amazonaws.com');
    expect(url.hostname).toMatch(/^bedrock-agentcore\.us-gov-west-1\./);
  });
});

// ---------------------------------------------------------------------------
// HTTP upgrade error translation
// ---------------------------------------------------------------------------

describe('connectShell error translation', () => {
  beforeEach(() => {
    wsState.reset();
  });

  it('translates 424 upgrade error to user-friendly message', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    await new Promise(r => setTimeout(r, 0));
    wsState.errorHandler?.(new Error('424 Failed Dependency'));

    await expect(connectPromise).rejects.toThrow(/Agent VM is not ready \(error 424\)/);
  });

  it('translates 429 upgrade error to session limit message', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    await new Promise(r => setTimeout(r, 0));
    wsState.errorHandler?.(new Error('429 Too Many Requests'));

    await expect(connectPromise).rejects.toThrow(/Maximum terminal sessions reached/);
  });

  it('translates 403 upgrade error to IAM permission message', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    await new Promise(r => setTimeout(r, 0));
    wsState.errorHandler?.(new Error('403 Forbidden'));

    await expect(connectPromise).rejects.toThrow(/Access denied \(403\)/);
  });

  it('passes through unknown error messages unchanged', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    await new Promise(r => setTimeout(r, 0));
    wsState.errorHandler?.(new Error('ECONNRESET'));

    await expect(connectPromise).rejects.toThrow('ECONNRESET');
  });
});

// ---------------------------------------------------------------------------
// Reconnect UX callbacks
// ---------------------------------------------------------------------------

describe('connectShell reconnect callbacks', () => {
  beforeEach(() => {
    wsState.reset();
  });

  it('calls onKicked when close code 4000 arrives and still throws ShellKickedError', async () => {
    const onKicked = vi.fn();
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      reconnect: { maxRetries: 1, onKicked },
    });

    await new Promise(r => setTimeout(r, 0));
    wsState.closeHandler?.(4000);

    await expect(connectPromise).rejects.toThrow(ShellKickedError);
    expect(onKicked).toHaveBeenCalledTimes(1);
  });

  it('calls onAttempt(1, reason) on first retry when WS fails before open', async () => {
    const onAttempt = vi.fn();

    // Use a very short base delay so the test doesn't wait
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      reconnect: { maxRetries: 2, baseDelay: 0.001, onAttempt },
    });

    // First attempt: let it get constructed, then fail with 1006
    await new Promise(r => setTimeout(r, 0));
    const firstCloseHandler = wsState.closeHandler;
    firstCloseHandler?.(1006);

    // Wait for backoff + second WS to be constructed
    await new Promise(r => setTimeout(r, 50));

    // Second attempt: fire open
    wsState.upgradeHandler?.({ headers: { 'x-amzn-bedrock-agentcore-shell-id': 'new-shell-id' } });
    wsState.openHandler?.();

    await connectPromise;

    expect(onAttempt).toHaveBeenCalledWith(1, expect.stringContaining('1006'));
  });
});

// ---------------------------------------------------------------------------
// startKeepalive
// ---------------------------------------------------------------------------

function makeMockWs() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  const pings: number[] = [];
  return {
    readyState: 1, // OPEN
    OPEN: 1,
    ping: vi.fn(() => {
      pings.push(Date.now());
    }),
    on: (event: string, fn: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(fn);
    },
    emit: (event: string, ...args: unknown[]) => listeners[event]?.forEach(fn => fn(...args)),
    removeAllListeners: (event?: string) => {
      if (event) delete listeners[event];
      else Object.keys(listeners).forEach(k => delete listeners[k]);
    },
    pings,
  };
}

describe('startKeepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends a ping after 30 seconds', () => {
    const ws = makeMockWs();
    startKeepalive(ws as unknown as import('ws').default, vi.fn());

    vi.advanceTimersByTime(30_000);

    expect(ws.ping).toHaveBeenCalledTimes(1);
  });

  it('calls onDead if no pong arrives within 60s after ping', () => {
    const ws = makeMockWs();
    const onDead = vi.fn();
    startKeepalive(ws as unknown as import('ws').default, onDead);

    // Trigger the ping at 30s
    vi.advanceTimersByTime(30_000);
    expect(ws.ping).toHaveBeenCalledTimes(1);

    // Advance 60 more seconds without a pong
    vi.advanceTimersByTime(60_000);
    expect(onDead).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onDead if a pong arrives before 60s timeout', () => {
    const ws = makeMockWs();
    const onDead = vi.fn();
    startKeepalive(ws as unknown as import('ws').default, onDead);

    // Trigger ping at 30s
    vi.advanceTimersByTime(30_000);
    expect(ws.ping).toHaveBeenCalledTimes(1);

    // Pong arrives at 35s (before 60s pong timeout at 90s)
    ws.emit('pong');

    // Advance past where onDead would have fired (90s total)
    vi.advanceTimersByTime(60_000);
    expect(onDead).not.toHaveBeenCalled();
  });

  it('does not ping or call onDead after stop() is called', () => {
    const ws = makeMockWs();
    const onDead = vi.fn();
    const stop = startKeepalive(ws as unknown as import('ws').default, onDead);

    stop();

    vi.advanceTimersByTime(30_000 + 60_000 + 1_000);

    expect(ws.ping).not.toHaveBeenCalled();
    expect(onDead).not.toHaveBeenCalled();
  });
});
