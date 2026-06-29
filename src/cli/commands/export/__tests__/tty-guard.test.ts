import { registerExport } from '../index';
import { Command } from '@commander-js/extra-typings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drive the REAL requireTTY (centralized inside renderTUI) by toggling
// process.stdin.isTTY / process.stdout.isTTY and spying on process.exit /
// console.error. Only the I/O boundaries renderTUI touches are mocked: the
// Ink renderer, telemetry, and post-command notices. The guard runs first in
// renderTUI, so a non-TTY context exits before any of these are reached.
const mockRender = vi.fn((..._args: unknown[]) => ({ waitUntilExit: () => Promise.resolve() }));

vi.mock('ink', () => ({
  render: (...args: unknown[]) => mockRender(...args),
}));

vi.mock('../../../telemetry', () => ({
  TelemetryClientAccessor: {
    init: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../../notices', () => ({
  printPostCommandNotices: vi.fn().mockResolvedValue(undefined),
}));

describe('export harness TTY guard', () => {
  let program: Command;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  const origStdinIsTTY = process.stdin.isTTY;
  const origStdoutIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerExport(program);

    // Swallow the alt-screen escape sequences renderTUI writes on the TTY path.
    writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.stdin.isTTY = origStdinIsTTY;
    process.stdout.isTTY = origStdoutIsTTY;
    writeSpy.mockRestore();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('exits with code 1 and never renders the TUI in a non-TTY context', async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;

    await expect(program.parseAsync(['export', 'harness'], { from: 'user' })).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('requires an interactive terminal'));
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('exits when only stdout is not a TTY', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = false;

    await expect(program.parseAsync(['export', 'harness'], { from: 'user' })).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('renders the TUI when both stdin and stdout are TTYs', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;

    await program.parseAsync(['export', 'harness'], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRender).toHaveBeenCalled();
  });
});
