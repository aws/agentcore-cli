import { registerArchive } from '../command.js';
import { Command } from '@commander-js/extra-typings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockArchive = vi.fn();
const mockRequireProject = vi.fn();

vi.mock('../../../operations/jobs', () => ({
  createJobEngine: () => ({ archive: (...args: unknown[]) => mockArchive(...args) }),
}));

vi.mock('../../../tui/guards', () => ({
  requireProject: (...args: unknown[]) => mockRequireProject(...args),
}));

// runCliCommand owns process.exit; stub it to run fn() and surface failures as a throw.
vi.mock('../../../telemetry/cli-command-run', () => ({
  runCliCommand: async (_command: string, _json: boolean, fn: () => Promise<unknown>) => {
    await fn();
  },
}));

vi.mock('../../../../lib', () => ({
  ConfigIO: function () {
    return {};
  },
}));

describe('registerArchive', () => {
  let program: Command;
  let mockLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerArchive(program);
    mockLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockArchive.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    mockLog.mockRestore();
    vi.clearAllMocks();
  });

  describe('command registration', () => {
    it('registers archive with both subcommands', () => {
      const archiveCmd = program.commands.find(c => c.name() === 'archive')!;
      expect(archiveCmd).toBeDefined();
      expect(archiveCmd.commands.find(c => c.name() === 'batch-evaluation')).toBeDefined();
      expect(archiveCmd.commands.find(c => c.name() === 'recommendation')).toBeDefined();
    });
  });

  describe('archive batch-evaluation', () => {
    it('rejects when --id is missing', async () => {
      await expect(program.parseAsync(['archive', 'batch-evaluation'], { from: 'user' })).rejects.toThrow();
      expect(mockArchive).not.toHaveBeenCalled();
    });

    it('calls engine.archive with the batch-evaluation type and id', async () => {
      await program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123'], { from: 'user' });
      expect(mockArchive).toHaveBeenCalledWith('batch-evaluation', 'eval-abc-123');
    });

    it('calls requireProject', async () => {
      await program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123'], { from: 'user' });
      expect(mockRequireProject).toHaveBeenCalled();
    });

    it('outputs JSON on success with --json', async () => {
      await program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123', '--json'], { from: 'user' });
      const output = JSON.parse(mockLog.mock.calls[0]![0]);
      expect(output.success).toBe(true);
      expect(output.id).toBe('eval-abc-123');
    });

    it('prints human-readable success output without --json', async () => {
      await program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123'], { from: 'user' });
      const allOutput = mockLog.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(allOutput).toContain('eval-abc-123');
      expect(allOutput).toContain('archived');
    });

    it('throws when engine.archive fails', async () => {
      mockArchive.mockResolvedValue({ success: false, error: new Error('Service unavailable') });
      await expect(
        program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123'], { from: 'user' })
      ).rejects.toThrow('Service unavailable');
    });
  });

  describe('archive recommendation', () => {
    it('calls engine.archive with the recommendation type and id', async () => {
      await program.parseAsync(['archive', 'recommendation', '--id', 'rec-xyz-789'], { from: 'user' });
      expect(mockArchive).toHaveBeenCalledWith('recommendation', 'rec-xyz-789');
    });

    it('outputs JSON on success with --json', async () => {
      await program.parseAsync(['archive', 'recommendation', '--id', 'rec-xyz-789', '--json'], { from: 'user' });
      const output = JSON.parse(mockLog.mock.calls[0]![0]);
      expect(output.success).toBe(true);
      expect(output.id).toBe('rec-xyz-789');
    });

    it('throws when engine.archive fails', async () => {
      mockArchive.mockResolvedValue({ success: false, error: new Error('Not found') });
      await expect(
        program.parseAsync(['archive', 'recommendation', '--id', 'rec-xyz-789'], { from: 'user' })
      ).rejects.toThrow('Not found');
    });
  });
});
