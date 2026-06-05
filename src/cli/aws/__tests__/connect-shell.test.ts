import { ShellKickedError } from '../../../lib/errors/types.js';
import { buildShellUrl, connectShell, startKeepalive } from '../connect-shell.js';
import { ShellChannel } from '../shell-framer.js';
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
    messageHandler: undefined as ((data: Buffer) => void) | undefined,
    closeHandler: undefined as ((code: number) => void) | undefined,
    errorHandler: undefined as ((err: Error) => void) | undefined,
    upgradeHandler: undefined as ((response: { headers: Record<string, string> }) => void) | undefined,
    terminateCalled: false,
    reset() {
      this.calls = [];
      this.messageHandler = undefined;
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
      if (event === 'message') wsState.messageHandler = handler as (data: Buffer) => void;
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
// connectShell
// ---------------------------------------------------------------------------

describe('connectShell', () => {
  function makeConfirmationFrame(shellId: string, reconnected = false): Buffer {
    const payload = JSON.stringify({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: { shellId, reconnected },
      status: 'Success',
    });
    return Buffer.concat([Buffer.from([ShellChannel.STATUS]), Buffer.from(payload)]);
  }

  beforeEach(() => {
    wsState.reset();
  });

  it('resolves with shellId from X-Amzn-Bedrock-AgentCore-Shell-Id 101 header (primary)', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    await new Promise(r => setTimeout(r, 0));
    // Header fires first (101 upgrade), then STATUS frame arrives
    wsState.upgradeHandler?.({ headers: { 'x-amzn-bedrock-agentcore-shell-id': 'header-shell-id' } });
    wsState.messageHandler?.(makeConfirmationFrame('frame-shell-id'));

    const conn = await connectPromise;
    // Header takes precedence over STATUS frame
    expect(conn.shellId).toBe('header-shell-id');
  });

  it('falls back to shellId from STATUS frame when header is absent', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    await new Promise(r => setTimeout(r, 0));
    // No upgrade event fired — STATUS frame is the only source
    wsState.messageHandler?.(makeConfirmationFrame('frame-shell-id'));

    const conn = await connectPromise;
    expect(conn.shellId).toBe('frame-shell-id');
  });

  it('resolves with shellId from STATUS confirmation frame', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    // Flush microtask queue (SigV4 signing chain needs >1 tick before WS is constructed)
    await new Promise(r => setTimeout(r, 0));
    wsState.messageHandler?.(makeConfirmationFrame('server-assigned-id'));

    const conn = await connectPromise;
    expect(conn.shellId).toBe('server-assigned-id');
    expect(conn.reconnected).toBe(false);
  });

  it('sets reconnected=true from STATUS frame metadata', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    await new Promise(r => setTimeout(r, 0));
    wsState.messageHandler?.(makeConfirmationFrame('existing-shell', true));

    const conn = await connectPromise;
    expect(conn.reconnected).toBe(true);
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

  it('throws generic error when WS closes with non-4000 code before confirmation', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    await new Promise(r => setTimeout(r, 0));
    wsState.closeHandler?.(1006);

    await expect(connectPromise).rejects.toThrow(/closed before confirmation/);
  });

  it('throws on WS error before confirmation', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    await new Promise(r => setTimeout(r, 0));
    wsState.errorHandler?.(new Error('ECONNREFUSED'));

    await expect(connectPromise).rejects.toThrow('ECONNREFUSED');
  });

  it('ignores non-STATUS frames before confirmation', async () => {
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
    });

    await new Promise(r => setTimeout(r, 0));
    // Send a STDOUT frame first — should be ignored
    const stdout = Buffer.concat([Buffer.from([ShellChannel.STDOUT]), Buffer.from('noise')]);
    wsState.messageHandler?.(stdout);
    // Then send confirmation
    wsState.messageHandler?.(makeConfirmationFrame('abc'));

    const conn = await connectPromise;
    expect(conn.shellId).toBe('abc');
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
    wsState.messageHandler?.(makeConfirmationFrame('reconnect-id', true));

    const conn = await connectPromise;
    expect(conn.shellId).toBe('reconnect-id');
    expect(conn.reconnected).toBe(true);

    expect(wsState.calls[0]).toContain('shellId=reconnect-id');
  });
});

// ---------------------------------------------------------------------------
// confirmationTimeoutMs — rejects if STATUS frame never arrives
// ---------------------------------------------------------------------------

describe('connectShell confirmationTimeoutMs', () => {
  beforeEach(() => {
    wsState.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects with timeout message when STATUS frame never arrives', async () => {
    // Use bearerToken path to bypass async SigV4 signing — WS is created synchronously
    // so the confirmation timer is registered before we advance fake timers.
    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      bearerToken: 'test-token',
      confirmationTimeoutMs: 5_000,
    });

    // One tick for the Promise constructor inside openWebSocket to run
    await Promise.resolve();
    vi.advanceTimersByTime(5_001);

    await expect(connectPromise).rejects.toThrow(/Timed out waiting for shell confirmation \(5s\)/);
  });

  it('does not reject when STATUS frame arrives before the timeout', async () => {
    // Use real timers for this test — fake timers interfere with the async signing chain.
    vi.useRealTimers();

    const connectPromise = connectShell({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      confirmationTimeoutMs: 5_000,
    });

    // Wait for the SigV4 signing microtasks + WS construction to complete
    await new Promise(r => setTimeout(r, 0));
    const payload = JSON.stringify({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: { shellId: 'fast-shell', reconnected: false },
      status: 'Success',
    });
    wsState.messageHandler?.(Buffer.concat([Buffer.from([ShellChannel.STATUS]), Buffer.from(payload)]));

    const conn = await connectPromise;
    expect(conn.shellId).toBe('fast-shell');
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
// Gap 1 — serviceEndpoint() in buildShellUrl (partition-aware prod URL)
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
    // GovCloud partition dnsSuffix is 'amazonaws.com' per @aws-sdk/util-endpoints
    expect(url.hostname).toBe('bedrock-agentcore.us-gov-west-1.amazonaws.com');
    // Confirm partition name is aws-us-gov (i.e. serviceEndpoint was used, not a hardcoded domain)
    expect(url.hostname).toMatch(/^bedrock-agentcore\.us-gov-west-1\./);
  });
});

// ---------------------------------------------------------------------------
// Gap 2 — HTTP upgrade error translation (indirect via WS mock)
// ---------------------------------------------------------------------------

describe('connectShell error translation', () => {
  function _makeConfirmationFrame(shellId: string, reconnected = false): Buffer {
    const payload = JSON.stringify({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: { shellId, reconnected },
      status: 'Success',
    });
    return Buffer.concat([Buffer.from([ShellChannel.STATUS]), Buffer.from(payload)]);
  }

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
// Gap 3 — Reconnect UX callbacks
// ---------------------------------------------------------------------------

describe('connectShell reconnect callbacks', () => {
  function makeConfirmationFrame(shellId: string, reconnected = false): Buffer {
    const payload = JSON.stringify({
      kind: 'Status',
      apiVersion: 'v1',
      metadata: { shellId, reconnected },
      status: 'Success',
    });
    return Buffer.concat([Buffer.from([ShellChannel.STATUS]), Buffer.from(payload)]);
  }

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

  it('calls onAttempt(1, reason) on first retry when WS fails before confirmation', async () => {
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

    // Second attempt: send confirmation
    wsState.messageHandler?.(makeConfirmationFrame('new-shell-id'));

    await connectPromise;

    expect(onAttempt).toHaveBeenCalledWith(1, expect.stringContaining('1006'));
  });
});

// ---------------------------------------------------------------------------
// Gap 5 — startKeepalive
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
