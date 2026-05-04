import { registerArchive } from '../command.js';
import { Command } from '@commander-js/extra-typings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockDeleteBatchEvaluation = vi.fn();
const mockDeleteRecommendation = vi.fn();
const mockDeleteLocalBatchEvalRun = vi.fn();
const mockDeleteLocalRecommendationRun = vi.fn();
const mockRequireProject = vi.fn();
const mockRender = vi.fn();
const mockResolveAWSDeploymentTargets = vi.fn();

vi.mock('../../../aws/agentcore-batch-evaluation', () => ({
  deleteBatchEvaluation: (...args: unknown[]) => mockDeleteBatchEvaluation(...args),
}));

vi.mock('../../../aws/agentcore-recommendation', () => ({
  deleteRecommendation: (...args: unknown[]) => mockDeleteRecommendation(...args),
}));

vi.mock('../../../operations/archive/archive-storage', () => ({
  deleteLocalBatchEvalRun: (...args: unknown[]) => mockDeleteLocalBatchEvalRun(...args),
  deleteLocalRecommendationRun: (...args: unknown[]) => mockDeleteLocalRecommendationRun(...args),
}));

vi.mock('../../../tui/guards', () => ({
  requireProject: (...args: unknown[]) => mockRequireProject(...args),
}));

vi.mock('ink', () => ({
  render: (...args: unknown[]) => mockRender(...args),
  Text: 'Text',
}));

vi.mock('../../../../lib', () => ({
  ConfigIO: function () {
    return { resolveAWSDeploymentTargets: () => mockResolveAWSDeploymentTargets() };
  },
}));

const batchEvalResult = {
  batchEvaluationId: 'eval-abc-123',
  batchEvaluationArn: 'arn:aws:bedrock:us-east-1:123456789:batch-evaluation/eval-abc-123',
  status: 'DELETED',
};

const recommendationResult = {
  recommendationId: 'rec-xyz-789',
  status: 'DELETED',
};

describe('registerArchive', () => {
  let program: Command;
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerArchive(program);

    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
    mockLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    mockResolveAWSDeploymentTargets.mockResolvedValue([{ region: 'us-east-1' }]);
    mockDeleteLocalBatchEvalRun.mockReturnValue(true);
    mockDeleteLocalRecommendationRun.mockReturnValue(true);
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockLog.mockRestore();
    vi.clearAllMocks();
  });

  describe('command registration', () => {
    it('registers archive command', () => {
      const archiveCmd = program.commands.find(c => c.name() === 'archive');
      expect(archiveCmd).toBeDefined();
    });

    it('registers batch-evaluation subcommand', () => {
      const archiveCmd = program.commands.find(c => c.name() === 'archive')!;
      const batchCmd = archiveCmd.commands.find(c => c.name() === 'batch-evaluation');
      expect(batchCmd).toBeDefined();
    });

    it('registers recommendation subcommand', () => {
      const archiveCmd = program.commands.find(c => c.name() === 'archive')!;
      const recCmd = archiveCmd.commands.find(c => c.name() === 'recommendation');
      expect(recCmd).toBeDefined();
    });
  });

  describe('archive batch-evaluation', () => {
    it('rejects when --id is missing', async () => {
      await expect(program.parseAsync(['archive', 'batch-evaluation'], { from: 'user' })).rejects.toThrow();
      expect(mockDeleteBatchEvaluation).not.toHaveBeenCalled();
    });

    it('calls deleteBatchEvaluation with the given id and auto-detected region', async () => {
      mockDeleteBatchEvaluation.mockResolvedValue(batchEvalResult);

      await program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123'], { from: 'user' });

      expect(mockDeleteBatchEvaluation).toHaveBeenCalledWith({
        region: 'us-east-1',
        batchEvaluationId: 'eval-abc-123',
      });
    });

    it('uses --region when provided', async () => {
      mockDeleteBatchEvaluation.mockResolvedValue(batchEvalResult);

      await program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123', '--region', 'eu-west-1'], {
        from: 'user',
      });

      expect(mockDeleteBatchEvaluation).toHaveBeenCalledWith({
        region: 'eu-west-1',
        batchEvaluationId: 'eval-abc-123',
      });
    });

    it('calls deleteLocalBatchEvalRun with the id', async () => {
      mockDeleteBatchEvaluation.mockResolvedValue(batchEvalResult);

      await program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123'], { from: 'user' });

      expect(mockDeleteLocalBatchEvalRun).toHaveBeenCalledWith('eval-abc-123');
    });

    it('outputs JSON on success with --json flag', async () => {
      mockDeleteBatchEvaluation.mockResolvedValue(batchEvalResult);

      await program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123', '--json'], { from: 'user' });

      expect(mockLog).toHaveBeenCalledTimes(1);
      const output = JSON.parse(mockLog.mock.calls[0]![0]);
      expect(output.success).toBe(true);
      expect(output.batchEvaluationId).toBe('eval-abc-123');
      expect(output.status).toBe('DELETED');
      expect(output.localCliHistoryDeleted).toBe(true);
    });

    it('includes localCliHistoryDeleted: false in JSON when local file was not found', async () => {
      mockDeleteBatchEvaluation.mockResolvedValue(batchEvalResult);
      mockDeleteLocalBatchEvalRun.mockReturnValue(false);

      await program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123', '--json'], { from: 'user' });

      const output = JSON.parse(mockLog.mock.calls[0]![0]);
      expect(output.localCliHistoryDeleted).toBe(false);
    });

    it('includes localDeleteWarning in JSON and exits 0 when local delete throws', async () => {
      mockDeleteBatchEvaluation.mockResolvedValue(batchEvalResult);
      mockDeleteLocalBatchEvalRun.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      await program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123', '--json'], { from: 'user' });

      const output = JSON.parse(mockLog.mock.calls[0]![0]);
      expect(output.success).toBe(true);
      expect(output.localCliHistoryDeleted).toBe(false);
      expect(output.localDeleteWarning).toBe('Permission denied');
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('prints warning and exits 0 when local delete throws without --json', async () => {
      mockDeleteBatchEvaluation.mockResolvedValue(batchEvalResult);
      mockDeleteLocalBatchEvalRun.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      await program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123'], { from: 'user' });

      const allOutput = mockLog.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(allOutput).toContain('Warning: could not clear local history: Permission denied');
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('prints human-readable success output without --json', async () => {
      mockDeleteBatchEvaluation.mockResolvedValue(batchEvalResult);

      await program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123'], { from: 'user' });

      const allOutput = mockLog.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(allOutput).toContain('eval-abc-123');
      expect(allOutput).toContain('DELETED');
    });

    it('does not call process.exit on success', async () => {
      mockDeleteBatchEvaluation.mockResolvedValue(batchEvalResult);

      await program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123'], { from: 'user' });

      expect(mockExit).not.toHaveBeenCalled();
    });

    it('outputs JSON error when deleteBatchEvaluation throws and --json is set', async () => {
      mockDeleteBatchEvaluation.mockRejectedValue(new Error('Service unavailable'));

      await expect(
        program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123', '--json'], { from: 'user' })
      ).rejects.toThrow('process.exit');

      const output = JSON.parse(mockLog.mock.calls[0]![0]);
      expect(output.success).toBe(false);
      expect(output.error).toBe('Service unavailable');
    });

    it('renders error via ink when deleteBatchEvaluation throws without --json', async () => {
      mockDeleteBatchEvaluation.mockRejectedValue(new Error('Service unavailable'));

      await expect(
        program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123'], { from: 'user' })
      ).rejects.toThrow('process.exit');

      expect(mockRender).toHaveBeenCalled();
      const renderArg = mockRender.mock.calls[0]![0];
      expect(JSON.stringify(renderArg)).toContain('Service unavailable');
    });

    it('exits with code 1 on error', async () => {
      mockDeleteBatchEvaluation.mockRejectedValue(new Error('fail'));

      await expect(
        program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123'], { from: 'user' })
      ).rejects.toThrow('process.exit');

      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('calls requireProject', async () => {
      mockDeleteBatchEvaluation.mockResolvedValue(batchEvalResult);

      await program.parseAsync(['archive', 'batch-evaluation', '--id', 'eval-abc-123'], { from: 'user' });

      expect(mockRequireProject).toHaveBeenCalled();
    });
  });

  describe('archive recommendation', () => {
    it('rejects when --id is missing', async () => {
      await expect(program.parseAsync(['archive', 'recommendation'], { from: 'user' })).rejects.toThrow();
      expect(mockDeleteRecommendation).not.toHaveBeenCalled();
    });

    it('calls deleteRecommendation with the given id and auto-detected region', async () => {
      mockDeleteRecommendation.mockResolvedValue(recommendationResult);

      await program.parseAsync(['archive', 'recommendation', '--id', 'rec-xyz-789'], { from: 'user' });

      expect(mockDeleteRecommendation).toHaveBeenCalledWith({
        region: 'us-east-1',
        recommendationId: 'rec-xyz-789',
      });
    });

    it('uses --region when provided', async () => {
      mockDeleteRecommendation.mockResolvedValue(recommendationResult);

      await program.parseAsync(['archive', 'recommendation', '--id', 'rec-xyz-789', '--region', 'ap-southeast-1'], {
        from: 'user',
      });

      expect(mockDeleteRecommendation).toHaveBeenCalledWith({
        region: 'ap-southeast-1',
        recommendationId: 'rec-xyz-789',
      });
    });

    it('calls deleteLocalRecommendationRun with the id', async () => {
      mockDeleteRecommendation.mockResolvedValue(recommendationResult);

      await program.parseAsync(['archive', 'recommendation', '--id', 'rec-xyz-789'], { from: 'user' });

      expect(mockDeleteLocalRecommendationRun).toHaveBeenCalledWith('rec-xyz-789');
    });

    it('outputs JSON on success with --json flag', async () => {
      mockDeleteRecommendation.mockResolvedValue(recommendationResult);

      await program.parseAsync(['archive', 'recommendation', '--id', 'rec-xyz-789', '--json'], { from: 'user' });

      expect(mockLog).toHaveBeenCalledTimes(1);
      const output = JSON.parse(mockLog.mock.calls[0]![0]);
      expect(output.success).toBe(true);
      expect(output.recommendationId).toBe('rec-xyz-789');
      expect(output.status).toBe('DELETED');
      expect(output.localCliHistoryDeleted).toBe(true);
    });

    it('includes localCliHistoryDeleted: false in JSON when local file was not found', async () => {
      mockDeleteRecommendation.mockResolvedValue(recommendationResult);
      mockDeleteLocalRecommendationRun.mockReturnValue(false);

      await program.parseAsync(['archive', 'recommendation', '--id', 'rec-xyz-789', '--json'], { from: 'user' });

      const output = JSON.parse(mockLog.mock.calls[0]![0]);
      expect(output.localCliHistoryDeleted).toBe(false);
    });

    it('includes localDeleteWarning in JSON and exits 0 when local delete throws', async () => {
      mockDeleteRecommendation.mockResolvedValue(recommendationResult);
      mockDeleteLocalRecommendationRun.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      await program.parseAsync(['archive', 'recommendation', '--id', 'rec-xyz-789', '--json'], { from: 'user' });

      const output = JSON.parse(mockLog.mock.calls[0]![0]);
      expect(output.success).toBe(true);
      expect(output.localCliHistoryDeleted).toBe(false);
      expect(output.localDeleteWarning).toBe('Permission denied');
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('prints warning and exits 0 when local delete throws without --json', async () => {
      mockDeleteRecommendation.mockResolvedValue(recommendationResult);
      mockDeleteLocalRecommendationRun.mockImplementation(() => {
        throw new Error('Permission denied');
      });

      await program.parseAsync(['archive', 'recommendation', '--id', 'rec-xyz-789'], { from: 'user' });

      const allOutput = mockLog.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(allOutput).toContain('Warning: could not clear local history: Permission denied');
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('prints human-readable success output without --json', async () => {
      mockDeleteRecommendation.mockResolvedValue(recommendationResult);

      await program.parseAsync(['archive', 'recommendation', '--id', 'rec-xyz-789'], { from: 'user' });

      const allOutput = mockLog.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
      expect(allOutput).toContain('rec-xyz-789');
      expect(allOutput).toContain('DELETED');
    });

    it('does not call process.exit on success', async () => {
      mockDeleteRecommendation.mockResolvedValue(recommendationResult);

      await program.parseAsync(['archive', 'recommendation', '--id', 'rec-xyz-789'], { from: 'user' });

      expect(mockExit).not.toHaveBeenCalled();
    });

    it('outputs JSON error when deleteRecommendation throws and --json is set', async () => {
      mockDeleteRecommendation.mockRejectedValue(new Error('Not found'));

      await expect(
        program.parseAsync(['archive', 'recommendation', '--id', 'rec-xyz-789', '--json'], { from: 'user' })
      ).rejects.toThrow('process.exit');

      const output = JSON.parse(mockLog.mock.calls[0]![0]);
      expect(output.success).toBe(false);
      expect(output.error).toBe('Not found');
    });

    it('renders error via ink when deleteRecommendation throws without --json', async () => {
      mockDeleteRecommendation.mockRejectedValue(new Error('Not found'));

      await expect(
        program.parseAsync(['archive', 'recommendation', '--id', 'rec-xyz-789'], { from: 'user' })
      ).rejects.toThrow('process.exit');

      expect(mockRender).toHaveBeenCalled();
      const renderArg = mockRender.mock.calls[0]![0];
      expect(JSON.stringify(renderArg)).toContain('Not found');
    });

    it('exits with code 1 on error', async () => {
      mockDeleteRecommendation.mockRejectedValue(new Error('fail'));

      await expect(
        program.parseAsync(['archive', 'recommendation', '--id', 'rec-xyz-789'], { from: 'user' })
      ).rejects.toThrow('process.exit');

      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('calls requireProject', async () => {
      mockDeleteRecommendation.mockResolvedValue(recommendationResult);

      await program.parseAsync(['archive', 'recommendation', '--id', 'rec-xyz-789'], { from: 'user' });

      expect(mockRequireProject).toHaveBeenCalled();
    });
  });
});
