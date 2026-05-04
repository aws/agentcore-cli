import { deleteLocalBatchEvalRun, deleteLocalRecommendationRun } from '../archive-storage.js';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindConfigRoot = vi.fn();

vi.mock('../../../../lib', () => ({
  findConfigRoot: () => mockFindConfigRoot(),
}));

function makeTmpDir(): string {
  const dir = join(tmpdir(), `archive-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonFile(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

describe('archive-storage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mockFindConfigRoot.mockReturnValue(tmpDir);
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  describe('deleteLocalBatchEvalRun', () => {
    it('deletes the file and returns true when file exists', () => {
      const filePath = join(tmpDir, '.cli', 'batch-eval-results', 'eval-123.json');
      writeJsonFile(filePath, { batchEvaluationId: 'eval-123' });

      const result = deleteLocalBatchEvalRun('eval-123');

      expect(result).toBe(true);
      expect(existsSync(filePath)).toBe(false);
    });

    it('returns false when file does not exist', () => {
      const result = deleteLocalBatchEvalRun('nonexistent-id');
      expect(result).toBe(false);
    });

    it('does not throw when the batch-eval-results directory does not exist', () => {
      expect(() => deleteLocalBatchEvalRun('any-id')).not.toThrow();
    });

    it('throws when findConfigRoot returns null', () => {
      mockFindConfigRoot.mockReturnValue(null);
      expect(() => deleteLocalBatchEvalRun('eval-123')).toThrow('No agentcore project found');
    });

    it('throws when id contains a forward slash', () => {
      expect(() => deleteLocalBatchEvalRun('../evil')).toThrow('Invalid batch evaluation ID');
    });

    it('throws when id contains a backslash', () => {
      expect(() => deleteLocalBatchEvalRun('evil\\path')).toThrow('Invalid batch evaluation ID');
    });

    it('leaves other files in the directory untouched', () => {
      const keep = join(tmpDir, '.cli', 'batch-eval-results', 'keep-me.json');
      const del = join(tmpDir, '.cli', 'batch-eval-results', 'delete-me.json');
      writeJsonFile(keep, { batchEvaluationId: 'keep-me' });
      writeJsonFile(del, { batchEvaluationId: 'delete-me' });

      deleteLocalBatchEvalRun('delete-me');

      expect(existsSync(keep)).toBe(true);
      expect(existsSync(del)).toBe(false);
    });
  });

  describe('deleteLocalRecommendationRun', () => {
    it('deletes the file and returns true when file exists', () => {
      const filePath = join(tmpDir, '.cli', 'recommendations', 'rec-456.json');
      writeJsonFile(filePath, { recommendationId: 'rec-456' });

      const result = deleteLocalRecommendationRun('rec-456');

      expect(result).toBe(true);
      expect(existsSync(filePath)).toBe(false);
    });

    it('returns false when file does not exist', () => {
      const result = deleteLocalRecommendationRun('nonexistent-id');
      expect(result).toBe(false);
    });

    it('does not throw when the recommendations directory does not exist', () => {
      expect(() => deleteLocalRecommendationRun('any-id')).not.toThrow();
    });

    it('throws when findConfigRoot returns null', () => {
      mockFindConfigRoot.mockReturnValue(null);
      expect(() => deleteLocalRecommendationRun('rec-456')).toThrow('No agentcore project found');
    });

    it('throws when id contains a forward slash', () => {
      expect(() => deleteLocalRecommendationRun('../evil')).toThrow('Invalid recommendation ID');
    });

    it('throws when id contains a backslash', () => {
      expect(() => deleteLocalRecommendationRun('evil\\path')).toThrow('Invalid recommendation ID');
    });

    it('leaves other files in the directory untouched', () => {
      const keep = join(tmpDir, '.cli', 'recommendations', 'keep-me.json');
      const del = join(tmpDir, '.cli', 'recommendations', 'delete-me.json');
      writeJsonFile(keep, { recommendationId: 'keep-me' });
      writeJsonFile(del, { recommendationId: 'delete-me' });

      deleteLocalRecommendationRun('delete-me');

      expect(existsSync(keep)).toBe(true);
      expect(existsSync(del)).toBe(false);
    });
  });
});
