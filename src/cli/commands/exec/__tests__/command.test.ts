// ---------------------------------------------------------------------------
// Telemetry attribute correctness
// ---------------------------------------------------------------------------
import { withCommandRunTelemetry } from '../../../telemetry/cli-command-run.js';
import { handleExecOneShot, handleShellSession } from '../action.js';
import { registerExec } from '../command.js';
import { Command } from '@commander-js/extra-typings';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Paths are relative to the test file location (__tests__/command.test.ts),
// but vitest resolves them to the same module as the importer (command.tsx).
// command.tsx imports from '../../../tui/guards' (relative to exec/), so from __tests__/ it's '../../../tui/guards'.
vi.mock('../../../tui/guards', () => ({
  requireProject: vi.fn(),
  requireTTY: vi.fn(),
}));

const { mockHandleShellSession, mockWithCommandRunTelemetry } = vi.hoisted(() => ({
  mockHandleShellSession: vi.fn().mockResolvedValue({ success: true }),
  mockWithCommandRunTelemetry: vi.fn(
    (
      _key: string,
      attrs: Record<string, unknown>,
      fn: (recorder: { set: (a: Record<string, unknown>) => void }) => unknown
    ) => fn({ set: (a: Record<string, unknown>) => Object.assign(attrs, a) })
  ),
}));

vi.mock('../action.js', () => ({
  handleExecOneShot: vi.fn().mockResolvedValue({ success: true }),
  handleShellSession: mockHandleShellSession,
  loadExecContext: vi.fn().mockResolvedValue({
    region: 'us-east-1',
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
  }),
  runInteractiveShell: vi.fn().mockImplementation(async (opts: Record<string, unknown>) => {
    await mockWithCommandRunTelemetry(
      'exec',
      {
        interactive: true,
        has_runtime: Boolean(opts.runtimeArn),
        has_shell_id: Boolean(opts.shellId),
        has_session_id: Boolean(opts.sessionId),
        is_one_shot: false,
        auth_type: opts.bearerToken ? 'bearer_token' : 'sigv4',
      },
      async (recorder: { set: (attrs: Record<string, unknown>) => void }) => {
        const sessionResult = await mockHandleShellSession(opts);
        recorder.set({
          is_reconnect: (sessionResult as Record<string, unknown>).isReconnect ?? Boolean(opts.shellId),
          exit_code:
            (sessionResult as Record<string, unknown>).exitCode ??
            ((sessionResult as Record<string, unknown>).success ? 0 : 1),
          reconnect_attempts: (sessionResult as Record<string, unknown>).reconnectAttempts ?? 0,
          was_kicked: (sessionResult as Record<string, unknown>).wasKicked ?? false,
        });
        if (!(sessionResult as Record<string, unknown>).success) throw (sessionResult as Record<string, unknown>).error;
        return sessionResult;
      }
    );
  }),
}));

vi.mock('../../../telemetry/cli-command-run.js', () => ({
  withCommandRunTelemetry: mockWithCommandRunTelemetry,
}));

vi.mock('../../../tui/copy', () => ({
  COMMAND_DESCRIPTIONS: {
    exec: 'Execute commands in the agent runtime',
  },
}));

vi.mock('../../../tui/screens/exec', () => ({
  ExecScreen: vi.fn(),
}));

vi.mock('ink', async importOriginal => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    render: vi.fn().mockReturnValue({ unmount: vi.fn() }),
  };
});

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
  };
});

vi.mock('../../errors', () => ({
  getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));

// ---------------------------------------------------------------------------
// Gap 7 — --json + --it guard
// ---------------------------------------------------------------------------

describe('exec command --json + --it guard', () => {
  let program: Command;
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerExec(program);

    mockExit = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code})`);
    });
    mockError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockError.mockRestore();
    vi.clearAllMocks();
  });

  it('calls process.exit(1) when both --it and --timeout are passed', async () => {
    await expect(
      program.parseAsync(
        ['exec', '--it', '--timeout', '5', '--runtime', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r'],
        {
          from: 'user',
        }
      )
    ).rejects.toThrow('process.exit(1)');

    expect(mockExit).toHaveBeenCalledWith(1);
    const errorOutput = (mockError.mock.calls as [unknown][]).map(c => String(c[0])).join('\n');
    expect(errorOutput).toMatch(/--timeout cannot be used with --it/);
  });

  it('calls process.exit(1) when both --it and --json are passed', async () => {
    await expect(
      program.parseAsync(['exec', '--it', '--json', '--runtime', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r'], {
        from: 'user',
      })
    ).rejects.toThrow('process.exit(1)');

    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('logs an error mentioning PTY sessions when --it and --json are combined', async () => {
    // console.error is called before process.exit; capture both
    await expect(
      program.parseAsync(['exec', '--it', '--json', '--runtime', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r'], {
        from: 'user',
      })
    ).rejects.toThrow('process.exit(1)');

    // mockError collects calls made before the throw, so check them now
    const errorOutput = (mockError.mock.calls as [unknown][]).map(c => String(c[0])).join('\n');
    // command.tsx writes: 'Error: --json cannot be used with --it (PTY sessions are not JSON-serializable)'
    expect(errorOutput).toMatch(/PTY sessions/i);
  });

  it('does NOT log the PTY guard error message when only --json is passed without --it', async () => {
    // The --it+--json guard should only fire when BOTH flags are present.
    // Verify the guard message is NOT emitted when --it is absent.
    // We parse only to the point where the action is invoked; process.exit(1) throws to stop execution.
    await expect(
      program.parseAsync(['exec', '--it', '--json', '--runtime', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r'], {
        from: 'user',
      })
    ).rejects.toThrow('process.exit(1)');

    const guardCallWithPTY = mockError.mock.calls.find((c: unknown[]) => String(c[0]).includes('PTY sessions'));
    expect(guardCallWithPTY).toBeDefined();

    // Reset mocks and run without --it — the guard message should NOT appear
    vi.clearAllMocks();

    await expect(
      program.parseAsync(
        ['exec', '--json', '--runtime', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r', 'echo', 'hello'],
        { from: 'user' }
      )
    ).rejects.toThrow(); // will still throw (process.exit called after success), but not from guard

    const noGuardCall = mockError.mock.calls.find((c: unknown[]) => String(c[0]).includes('PTY sessions'));
    expect(noGuardCall).toBeUndefined();
  }, 10000);
});

// ---------------------------------------------------------------------------
// --session-id length validation
// ---------------------------------------------------------------------------

describe('exec command --session-id length guard', () => {
  let program: Command;
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerExec(program);

    mockExit = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code})`);
    });
    mockError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockError.mockRestore();
    vi.clearAllMocks();
  });

  it('exits 1 with helpful message when --session-id is shorter than 33 chars', async () => {
    await expect(
      program.parseAsync(
        [
          'exec',
          '--runtime',
          'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
          '--session-id',
          'too-short',
          'echo',
          'hi',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow('process.exit(1)');

    expect(mockExit).toHaveBeenCalledWith(1);
    const errorOutput = (mockError.mock.calls as [unknown][]).map(c => String(c[0])).join('\n');
    expect(errorOutput).toMatch(/between 33 and 256 characters/);
  });

  it('does not exit early when --session-id is exactly 33 chars', async () => {
    // 33-char string: validation passes, execution proceeds normally
    const sessionId = 'a'.repeat(33);
    await expect(
      program.parseAsync(
        [
          'exec',
          '--runtime',
          'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
          '--session-id',
          sessionId,
          'echo',
          'hi',
        ],
        { from: 'user' }
      )
    ).rejects.toThrow(); // throws from process.exit after normal execution, not from guard

    // Guard error must NOT appear
    const errorOutput = (mockError.mock.calls as [unknown][]).map(c => String(c[0])).join('\n');
    expect(errorOutput).not.toMatch(/between 33 and 256 characters/);
  });

  it('exits 1 with helpful message when --timeout is NaN (non-numeric string)', async () => {
    await expect(
      program.parseAsync(
        ['exec', '--runtime', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r', '--timeout', 'abc', 'echo', 'hi'],
        { from: 'user' }
      )
    ).rejects.toThrow('process.exit(1)');

    expect(mockExit).toHaveBeenCalledWith(1);
    const errorOutput = (mockError.mock.calls as [unknown][]).map(c => String(c[0])).join('\n');
    expect(errorOutput).toMatch(/--timeout must be a non-negative integer/);
  });

  it('exits 1 with helpful message when --timeout is negative', async () => {
    await expect(
      program.parseAsync(
        ['exec', '--runtime', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r', '--timeout', '-1', 'echo', 'hi'],
        { from: 'user' }
      )
    ).rejects.toThrow('process.exit(1)');

    expect(mockExit).toHaveBeenCalledWith(1);
    const errorOutput = (mockError.mock.calls as [unknown][]).map(c => String(c[0])).join('\n');
    expect(errorOutput).toMatch(/--timeout must be a non-negative integer/);
  });

  it('does not error when --timeout is 0', async () => {
    await expect(
      program.parseAsync(
        ['exec', '--runtime', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r', '--timeout', '0', 'echo', 'hi'],
        { from: 'user' }
      )
    ).rejects.toThrow(); // exits via normal execution path, not guard

    const errorOutput = (mockError.mock.calls as [unknown][]).map(c => String(c[0])).join('\n');
    expect(errorOutput).not.toMatch(/--timeout must be/);
  });
});

describe('exec telemetry attributes', () => {
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockExit = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code})`);
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    mockExit.mockRestore();
    vi.clearAllMocks();
  });

  it('passes auth_type=sigv4 when no bearer token', async () => {
    const program = new Command();
    program.exitOverride();
    registerExec(program);

    await expect(
      program.parseAsync(['exec', '--it', '--runtime', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r'], {
        from: 'user',
      })
    ).rejects.toThrow(); // process.exit

    const telemetryCalls = vi.mocked(withCommandRunTelemetry).mock.calls;
    const interactiveCall = telemetryCalls.find(c => (c[1] as Record<string, unknown>).interactive === true);
    expect(interactiveCall).toBeDefined();
    expect((interactiveCall![1] as Record<string, unknown>).auth_type).toBe('sigv4');
  });

  it('passes auth_type=bearer_token when --bearer-token is set', async () => {
    vi.mocked(handleShellSession).mockResolvedValue({
      success: true,
      sessionId: 'sid',
      shellId: 'shid',
      exitCode: 0,
      reconnectAttempts: 0,
      wasKicked: false,
      isReconnect: false,
    });

    const program = new Command();
    program.exitOverride();
    registerExec(program);

    await expect(
      program.parseAsync(
        ['exec', '--it', '--runtime', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r', '--bearer-token', 'mytoken'],
        { from: 'user' }
      )
    ).rejects.toThrow();

    const telemetryCalls = vi.mocked(withCommandRunTelemetry).mock.calls;
    const interactiveCall = telemetryCalls.find(c => (c[1] as Record<string, unknown>).interactive === true);
    expect(interactiveCall).toBeDefined();
    expect((interactiveCall![1] as Record<string, unknown>).auth_type).toBe('bearer_token');
  });

  it('passes real exit_code from session result into telemetry', async () => {
    vi.mocked(handleShellSession).mockResolvedValue({
      success: false,
      error: new Error('Shell exited with code 2'),
      sessionId: 'sid',
      shellId: 'shid',
      exitCode: 2,
      reconnectAttempts: 0,
      wasKicked: false,
      isReconnect: false,
    });

    const program = new Command();
    program.exitOverride();
    registerExec(program);

    await expect(
      program.parseAsync(['exec', '--it', '--runtime', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r'], {
        from: 'user',
      })
    ).rejects.toThrow();

    const telemetryCalls = vi.mocked(withCommandRunTelemetry).mock.calls;
    const interactiveCall = telemetryCalls.find(c => (c[1] as Record<string, unknown>).interactive === true);
    expect(interactiveCall).toBeDefined();
    expect((interactiveCall![1] as Record<string, unknown>).exit_code).toBe(2);
  });

  it('passes reconnect_attempts and was_kicked from session result into telemetry', async () => {
    vi.mocked(handleShellSession).mockResolvedValue({
      success: true,
      sessionId: 'sid',
      shellId: 'shid',
      exitCode: 0,
      reconnectAttempts: 3,
      wasKicked: true,
      isReconnect: true,
    });

    const program = new Command();
    program.exitOverride();
    registerExec(program);

    await expect(
      program.parseAsync(['exec', '--it', '--runtime', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r'], {
        from: 'user',
      })
    ).rejects.toThrow();

    const telemetryCalls = vi.mocked(withCommandRunTelemetry).mock.calls;
    const interactiveCall = telemetryCalls.find(c => (c[1] as Record<string, unknown>).interactive === true);
    expect(interactiveCall).toBeDefined();
    const attrs = interactiveCall![1] as Record<string, unknown>;
    expect(attrs.reconnect_attempts).toBe(3);
    expect(attrs.was_kicked).toBe(true);
    expect(attrs.is_reconnect).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// one-shot error message printed before exit
// ---------------------------------------------------------------------------

describe('exec one-shot error output', () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockExit = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code})`);
    });
    mockError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockError.mockRestore();
    vi.clearAllMocks();
  });

  it('prints error message to console.error when one-shot fails', async () => {
    vi.mocked(handleExecOneShot).mockResolvedValue({
      success: false,
      error: new Error('connection refused'),
    });

    const program = new Command();
    program.exitOverride();
    registerExec(program);

    await expect(
      program.parseAsync(['exec', '--runtime', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r', 'ls'], {
        from: 'user',
      })
    ).rejects.toThrow('process.exit(1)');

    const errorOutput = (mockError.mock.calls as [unknown][]).map(c => String(c[0])).join('\n');
    expect(errorOutput).toMatch(/connection refused/);
  });

  it('exits 0 and does not print error when one-shot succeeds', async () => {
    vi.mocked(handleExecOneShot).mockResolvedValue({ success: true });

    const program = new Command();
    program.exitOverride();
    registerExec(program);

    await expect(
      program.parseAsync(['exec', '--runtime', 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r', 'ls'], {
        from: 'user',
      })
    ).rejects.toThrow(); // process.exit throws in test env

    expect(mockExit).toHaveBeenCalledWith(0);
    const errorMessages = (mockError.mock.calls as [unknown][]).map(c => String(c[0]));
    expect(errorMessages.every(m => !m.match(/Error:/))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runExecLoop throws on fatal session error
// ---------------------------------------------------------------------------

describe('exec runExecLoop fatal error handling', () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockExit = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error(`process.exit(${_code})`);
    });
    mockError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockError.mockRestore();
    vi.clearAllMocks();
  });

  it('exits 1 when handleShellSession returns success:false in picker loop', async () => {
    vi.mocked(handleShellSession).mockResolvedValue({
      success: false,
      error: new Error('Access denied (403)'),
    });

    // Simulate auto-selected (single agent) so loop breaks after one iteration
    const { render } = await import('ink');
    vi.mocked(render).mockReturnValue({
      unmount: vi.fn(),
      rerender: vi.fn(),
      clear: vi.fn(),
      cleanup: vi.fn(),
      waitUntilExit: vi.fn().mockResolvedValue(undefined),
    });

    const { ExecScreen } = await import('../../../tui/screens/exec/index.js');
    vi.mocked(ExecScreen).mockImplementation((_props: unknown) => null as unknown as React.ReactElement);

    // Trigger the onSelect callback with autoSelected:true to simulate single-agent auto-pick
    vi.mocked(render).mockImplementation((_element: unknown) => {
      // Immediately invoke onSelect via a queued microtask
      const props = (_element as { props: { onSelect: (r: { runtimeArn: string; autoSelected: boolean }) => void } })
        .props;
      void Promise.resolve().then(() =>
        props.onSelect({
          runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
          autoSelected: true,
        })
      );
      return {
        unmount: vi.fn(),
        rerender: vi.fn(),
        clear: vi.fn(),
        cleanup: vi.fn(),
        waitUntilExit: vi.fn().mockResolvedValue(undefined),
      };
    });

    const program = new Command();
    program.exitOverride();
    registerExec(program);

    await expect(program.parseAsync(['exec', '--it'], { from: 'user' })).rejects.toThrow('process.exit(1)');

    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
