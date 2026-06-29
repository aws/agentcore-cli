import { registerView } from '../command';
import { Command } from '@commander-js/extra-typings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drive the REAL requireTTY by toggling process.stdin.isTTY / process.stdout.isTTY
// and spying on process.exit / console.error. Only the I/O boundaries are mocked:
// the Ink renderer and the TUI screens. requireProject is stubbed to a no-op so
// the TTY guard (which runs after it inside launchTuiList/launchTuiDetail) is what
// we exercise. All four job types are parameterized so a future refactor that
// moved the guard into a per-type branch would be caught.
const mockRender = vi.fn();

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

vi.mock('../../../tui/screens/recommendation', () => ({ RecommendationHistoryScreen: () => null }));
vi.mock('../../../tui/screens/run-eval', () => ({ BatchEvalHistoryScreen: () => null }));
vi.mock('../../../tui/screens/run-ab-test', () => ({ ABTestJobsHistoryScreen: () => null }));
vi.mock('../../../tui/screens/insights-jobs', () => ({ InsightsJobsScreen: () => null }));
vi.mock('../JobDetailScreen', () => ({ JobDetailScreen: () => null }));

const JOB_TYPES = ['recommendation', 'batch-evaluation', 'ab-test', 'insights'] as const;

describe('view TTY guard', () => {
  let program: Command;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const origStdinIsTTY = process.stdin.isTTY;
  const origStdoutIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerView(program);

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

  describe.each(JOB_TYPES)('view %s', type => {
    it('guards the interactive list — exits and never renders in a non-TTY context', async () => {
      process.stdin.isTTY = false;
      process.stdout.isTTY = false;

      await expect(program.parseAsync(['view', type], { from: 'user' })).rejects.toThrow('process.exit(1)');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('requires an interactive terminal'));
      expect(mockRender).not.toHaveBeenCalled();
    });

    it('renders the interactive list when both stdin and stdout are TTYs', async () => {
      process.stdin.isTTY = true;
      process.stdout.isTTY = true;

      // launchTuiList resolves a never-settling promise (the TUI owns the event
      // loop until the user exits), so race the parse against the render rather
      // than awaiting it.
      void program.parseAsync(['view', type], { from: 'user' });
      await vi.waitFor(() => expect(mockRender).toHaveBeenCalled());

      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  it('guards the interactive detail — exits and never renders in a non-TTY context', async () => {
    process.stdin.isTTY = false;
    process.stdout.isTTY = true;

    await expect(program.parseAsync(['view', 'recommendation', 'rec-1'], { from: 'user' })).rejects.toThrow(
      'process.exit(1)'
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('renders the interactive detail when both stdin and stdout are TTYs', async () => {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;

    void program.parseAsync(['view', 'recommendation', 'rec-1'], { from: 'user' });
    await vi.waitFor(() => expect(mockRender).toHaveBeenCalled());

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
