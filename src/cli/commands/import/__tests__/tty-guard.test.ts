import { registerImport } from '../command';
import { Command } from '@commander-js/extra-typings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drive the REAL requireTTY by toggling process.stdin.isTTY / process.stdout.isTTY
// and spying on process.exit / console.error. Only the I/O boundaries are mocked:
// the Ink renderer and the ImportFlow screen. requireProject is stubbed to a no-op
// so the TTY guard (which runs after it) is what we exercise here.
const mockRender = vi.fn((..._args: unknown[]) => ({ clear: vi.fn(), unmount: vi.fn() }));

vi.mock('../../../tui/guards', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../tui/guards')>();
  return {
    ...actual,
    requireProject: vi.fn(),
  };
});

vi.mock('ink', () => ({
  render: (...args: unknown[]) => mockRender(...args),
}));

vi.mock('../../../tui/screens/import', () => ({ ImportFlow: () => null }));

describe('import non-source TTY guard', () => {
  let program: Command;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const origStdinIsTTY = process.stdin.isTTY;
  const origStdoutIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerImport(program);

    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.stdin.isTTY = origStdinIsTTY;
    process.stdout.isTTY = origStdoutIsTTY;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('exits with code 1 and does not render in a non-TTY context', async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;

    await expect(program.parseAsync(['import'], { from: 'user' })).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('requires an interactive terminal'));
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('exits when only stdin is not a TTY', async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = true;

    await expect(program.parseAsync(['import'], { from: 'user' })).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('renders the interactive flow when both stdin and stdout are TTYs', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;

    await program.parseAsync(['import'], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRender).toHaveBeenCalled();
  });
});
