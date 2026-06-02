// Tests for invoke CLI mode — exitCode propagation and flag validation
import { handleInvoke } from '../action.js';
import { registerInvoke } from '../command.js';
import { resolvePrompt } from '../resolve-prompt.js';
import { Command } from '@commander-js/extra-typings';
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

vi.mock('../../errors', () => ({
  getErrorMessage: vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}));

vi.mock('../../../tui', () => ({
  renderTUI: vi.fn().mockResolvedValue(undefined),
  setupAltScreenCleanup: vi.fn(),
}));

vi.mock('ink', () => ({
  render: vi.fn(),
  Text: vi.fn(() => null),
  useInput: vi.fn(),
}));

vi.mock('react', async importOriginal => ({ ...(await importOriginal<typeof import('react')>()) }));

vi.mock('../../../feature-flags', () => ({
  isPreviewEnabled: vi.fn().mockReturnValue(false),
}));

vi.mock('../validate.js', () => ({
  validateInvokeOptions: vi.fn().mockReturnValue({ valid: true }),
}));

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
