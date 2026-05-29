// Tests for runInvokeTUI — the PTY shell-jump loop in invoke/command.tsx.
//
// These tests exercise:
//  1. onExec callback → handleShellSession called → loop continues back to picker
//  2. Multiple exec jumps → handleShellSession called each time
//  3. PTY error (handleShellSession throws) → error written to stderr, loop continues
//  4. PTY error (loadExecContext throws) → error written to stderr, loop continues
//  5. Error in PTY does not propagate — command resolves cleanly
import { handleShellSession, loadExecContext } from '../../exec/action.js';
import { handleInvoke } from '../action.js';
import { registerInvoke } from '../command.js';
import { resolvePrompt } from '../resolve-prompt.js';
import { Command } from '@commander-js/extra-typings';
import { render } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../tui/guards', () => ({
  requireProject: vi.fn(),
  requireTTY: vi.fn(),
}));

vi.mock('../../../telemetry/cli-command-run.js', () => ({
  withCommandRunTelemetry: vi.fn((_key: string, _attrs: unknown, fn: () => unknown) => fn()),
}));

vi.mock('../../../tui/copy', () => ({
  COMMAND_DESCRIPTIONS: { invoke: 'Invoke an agent' },
}));

vi.mock('../action.js', () => ({
  loadInvokeConfig: vi.fn().mockResolvedValue({ project: { runtimes: [] } }),
  handleInvoke: vi.fn(),
}));

vi.mock('../resolve-prompt.js', () => ({
  resolvePrompt: vi.fn().mockResolvedValue({ success: true, prompt: undefined }),
}));

vi.mock('../../exec/action.js', () => ({
  handleShellSession: vi.fn().mockResolvedValue({ success: true }),
  loadExecContext: vi.fn().mockResolvedValue({
    region: 'us-east-1',
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
  }),
}));

// Ink mock: render is a vi.fn() configured per-test via setupRender().
vi.mock('ink', () => ({
  render: vi.fn(),
  Text: vi.fn(() => null),
  useInput: vi.fn(),
}));

vi.mock('react', async importOriginal => ({ ...(await importOriginal<typeof import('react')>()) }));

vi.mock('../../errors', () => ({
  getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));

vi.mock('../../../tui/screens/invoke', () => ({ InvokeScreen: vi.fn(() => null) }));

// ---------------------------------------------------------------------------
// Helper: configure render to fire onExec/onExit in sequence
// ---------------------------------------------------------------------------

interface ExecPayload {
  runtimeArn: string;
  region: string;
  sessionId?: string;
}

/**
 * Configure the Ink render mock so each successive call either fires onExec
 * (with the given payload) or onExit (when the slot is null).
 *
 * The render mock reads onExec/onExit directly from element.props so it can
 * trigger the callbacks that waitForInvokeOrExec set on <InvokeScreen>.
 */
function setupRender(sequence: (ExecPayload | null)[]): void {
  let callIndex = 0;

  vi.mocked(render).mockImplementation((element: unknown) => {
    const props = (element as { props?: Record<string, unknown> })?.props ?? {};
    const onExec = props.onExec as ((r: ExecPayload) => void) | undefined;
    const onExit = props.onExit as (() => void) | undefined;

    // Each render call gets its own promise so the loop can iterate correctly.
    let resolveWait!: () => void;
    const waitPromise = new Promise<void>(r => {
      resolveWait = r;
    });

    // unmount() resolves the waitUntilExit promise — mirrors what Ink does.
    const unmount = vi.fn(() => resolveWait());
    const waitUntilExit = vi.fn(() => waitPromise);

    const item = sequence[callIndex++] ?? null;

    // Fire after a tick so the `const { unmount } = render(...)` destructuring
    // has completed and the closures inside onExec/onExit capture the right value.
    setTimeout(() => {
      if (item !== null) {
        onExec?.(item);
      } else {
        onExit?.();
      }
    }, 0);

    return { waitUntilExit, unmount, rerender: vi.fn(), cleanup: vi.fn(), clear: vi.fn() };
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
});

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerInvoke(program);
  return program;
}

async function parseTUI(program: Command): Promise<void> {
  await program.parseAsync(['invoke'], { from: 'user' });
}

// ---------------------------------------------------------------------------
// Tests — onExec triggers handleShellSession
// ---------------------------------------------------------------------------

describe('runInvokeTUI — onExec triggers handleShellSession', () => {
  it('calls loadExecContext and handleShellSession with the runtimeArn and sessionId from onExec', async () => {
    const execPayload: ExecPayload = {
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      region: 'us-east-1',
      sessionId: 'test-session-id',
    };

    // First render fires onExec; second render fires onExit → loop breaks
    setupRender([execPayload, null]);

    await parseTUI(buildProgram());

    expect(loadExecContext).toHaveBeenCalledWith({
      runtimeArn: execPayload.runtimeArn,
      region: execPayload.region,
    });
    expect(handleShellSession).toHaveBeenCalledWith(
      { region: 'us-east-1', runtimeArn: execPayload.runtimeArn },
      { runtimeArn: execPayload.runtimeArn, sessionId: execPayload.sessionId }
    );
  });

  it('renders InvokeScreen again after PTY session completes (loop continues)', async () => {
    const execPayload: ExecPayload = {
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      region: 'us-east-1',
      sessionId: undefined,
    };

    // Two exec jumps then exit → handleShellSession called twice, render called 3 times
    setupRender([execPayload, execPayload, null]);

    await parseTUI(buildProgram());

    expect(handleShellSession).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalledTimes(3);
  });

  it('passes sessionId from exec result as resumeSessionId on the next render', async () => {
    const first: ExecPayload = {
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      region: 'us-east-1',
      sessionId: 'session-abc',
    };

    setupRender([first, null]);

    await parseTUI(buildProgram());

    // The second render (after the PTY) should have initialSessionId = 'session-abc'
    const secondRenderElement = (vi.mocked(render).mock.calls[1]?.[0] as { props?: Record<string, unknown> })?.props;
    expect(secondRenderElement?.initialSessionId).toBe('session-abc');
  });

  it('sets isResume=true on the second and subsequent renders', async () => {
    const execPayload: ExecPayload = {
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      region: 'us-east-1',
      sessionId: undefined,
    };

    setupRender([execPayload, null]);

    await parseTUI(buildProgram());

    const firstProps = (vi.mocked(render).mock.calls[0]?.[0] as { props?: Record<string, unknown> })?.props;
    const secondProps = (vi.mocked(render).mock.calls[1]?.[0] as { props?: Record<string, unknown> })?.props;
    expect(firstProps?.isResume).toBeFalsy();
    expect(secondProps?.isResume).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — PTY error handling
// ---------------------------------------------------------------------------

describe('runInvokeTUI — PTY error handling', () => {
  it('writes "[shell error: ...]" to stderr when handleShellSession throws', async () => {
    vi.mocked(handleShellSession).mockRejectedValueOnce(new Error('connection refused'));

    const execPayload: ExecPayload = {
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      region: 'us-east-1',
      sessionId: undefined,
    };
    setupRender([execPayload, null]);

    await parseTUI(buildProgram());

    const stderrOutput = (stderrSpy.mock.calls as [unknown][]).map(c => String(c[0])).join('');
    expect(stderrOutput).toMatch(/shell error.*connection refused/i);
  });

  it('loops back to picker after handleShellSession throws', async () => {
    vi.mocked(handleShellSession).mockRejectedValueOnce(new Error('connection refused'));

    const execPayload: ExecPayload = {
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      region: 'us-east-1',
      sessionId: undefined,
    };
    setupRender([execPayload, null]);

    await parseTUI(buildProgram());

    // Loop continued: render was called twice (exec iteration + exit iteration)
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('writes "[shell error: ...]" to stderr when loadExecContext throws', async () => {
    vi.mocked(loadExecContext).mockRejectedValueOnce(new Error('no deployed runtimes'));

    const execPayload: ExecPayload = {
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      region: 'us-east-1',
      sessionId: undefined,
    };
    setupRender([execPayload, null]);

    await parseTUI(buildProgram());

    const stderrOutput = (stderrSpy.mock.calls as [unknown][]).map(c => String(c[0])).join('');
    expect(stderrOutput).toMatch(/shell error.*no deployed runtimes/i);
    expect(handleShellSession).not.toHaveBeenCalled();
  });

  it('does not propagate the error — command resolves cleanly after the loop exits', async () => {
    vi.mocked(handleShellSession).mockRejectedValueOnce(new Error('network timeout'));

    const execPayload: ExecPayload = {
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
      region: 'us-east-1',
      sessionId: undefined,
    };
    setupRender([execPayload, null]);

    await expect(parseTUI(buildProgram())).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests — invoke CLI mode exitCode propagation
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-empty-function
const _noop = () => {};

describe('invoke CLI mode — exitCode propagation', () => {
  let exitCodes: (number | undefined)[];

  beforeEach(() => {
    vi.clearAllMocks();
    exitCodes = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Capture exit codes without throwing so the outer catch block doesn't re-exit
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      exitCodes.push(typeof code === 'number' ? code : undefined);
      return undefined as never;
    });
    // Re-establish base mocks cleared by vi.clearAllMocks()
    vi.mocked(resolvePrompt).mockResolvedValue({ success: true, prompt: 'test prompt' });
    vi.mocked(handleInvoke).mockResolvedValue({ success: true, exitCode: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits with the real exitCode from InvokeResult, not just 0 or 1', async () => {
    vi.mocked(handleInvoke).mockResolvedValueOnce({
      success: false,
      exitCode: 42,
      error: new Error('Command exited with code 42'),
    });

    const program = new Command();
    program.exitOverride();
    registerInvoke(program);

    await program.parseAsync(['invoke', '--json', 'run something'], { from: 'user' }).catch(_noop);

    expect(exitCodes[0]).toBe(42);
  });

  it('exits 0 when InvokeResult is successful with exitCode:0', async () => {
    vi.mocked(handleInvoke).mockResolvedValueOnce({ success: true, exitCode: 0 });

    const program = new Command();
    program.exitOverride();
    registerInvoke(program);

    await program.parseAsync(['invoke', '--json', 'run something'], { from: 'user' }).catch(_noop);

    expect(exitCodes[0]).toBe(0);
  });

  it('exits 1 when InvokeResult has no exitCode and success:false', async () => {
    vi.mocked(handleInvoke).mockResolvedValueOnce({
      success: false,
      error: new Error('agent error'),
    });

    const program = new Command();
    program.exitOverride();
    registerInvoke(program);

    await program.parseAsync(['invoke', '--json', 'run something'], { from: 'user' }).catch(_noop);

    expect(exitCodes[0]).toBe(1);
  });
});
