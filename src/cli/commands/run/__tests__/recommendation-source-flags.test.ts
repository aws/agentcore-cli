import { registerRun } from '../command';
import { Command } from '@commander-js/extra-typings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// B2: conflicting trace-source flags must fail locally, naming the conflict,
// before any job engine (API) call. requireProject is stubbed so the check
// under test is what we exercise; createJobEngine is spied to prove no API call.
const mockStart = vi.fn();

vi.mock('../../../tui/guards', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../tui/guards')>();
  return { ...actual, requireProject: vi.fn() };
});

vi.mock('../../../operations/jobs', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../operations/jobs')>();
  return { ...actual, createJobEngine: () => ({ start: mockStart }) };
});

vi.mock('ink', () => ({ render: vi.fn(), Text: () => null }));

describe('run recommendation trace-source flags', () => {
  let program: Command;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerRun(program);

    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${code})`);
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('rejects two conflicting sources locally without hitting the service', async () => {
    await expect(
      program.parseAsync(
        ['run', 'recommendation', '--batch-evaluation-arn', 'x', '--online-evaluation-arn', 'y', '--json'],
        { from: 'user' }
      )
    ).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockStart).not.toHaveBeenCalled();

    const payload = JSON.parse(logSpy.mock.calls.at(-1)![0] as string) as { success: boolean; error: string };
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('--batch-evaluation-arn');
    expect(payload.error).toContain('--online-evaluation-arn');
  });
});
