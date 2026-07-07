import { launchTuiDevScreenWithPicker } from '../browser-mode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drive the REAL requireTTY by toggling process.stdin.isTTY / process.stdout.isTTY
// and spying on process.exit / console.error. Only the I/O boundaries are mocked:
// the Ink renderer and the DevScreen the picker renders. This pins the guard that
// PR #1640 centralized — the browser-mode harness picker must refuse to render in a
// non-TTY context instead of throwing Ink's "Raw mode is not supported" stack trace.
const mockRender = vi.fn((..._args: unknown[]) => ({
  unmount: vi.fn(),
  waitUntilExit: () => Promise.resolve(),
}));

vi.mock('ink', () => ({
  render: (...args: unknown[]) => mockRender(...args),
}));

vi.mock('../../../tui/screens/dev/DevScreen', () => ({ DevScreen: () => null }));

describe('dev browser-mode picker TTY guard', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
  const origStdinIsTTY = process.stdin.isTTY;
  const origStdoutIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.stdin.isTTY = origStdinIsTTY;
    process.stdout.isTTY = origStdoutIsTTY;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('exits with code 1 and never renders in a non-TTY context', async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = false;

    await expect(launchTuiDevScreenWithPicker('/tmp/project')).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('requires an interactive terminal'));
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('exits when only stdin is not a TTY', async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = true;

    await expect(launchTuiDevScreenWithPicker('/tmp/project')).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('exits when only stdout is not a TTY', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = false;

    await expect(launchTuiDevScreenWithPicker('/tmp/project')).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('renders the picker when both stdin and stdout are TTYs', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;

    await launchTuiDevScreenWithPicker('/tmp/project');

    expect(exitSpy).not.toHaveBeenCalled();
    expect(mockRender).toHaveBeenCalled();
  });
});
