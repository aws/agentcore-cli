import { generateFilename, getResultsPath, listEvalRuns, loadEvalRun, saveEvalRun } from '../storage.js';
import type { EvalRunResult } from '../types.js';
// Use real fs via a temp directory
import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindConfigRoot = vi.fn();

vi.mock('../../../../lib', () => ({
  findConfigRoot: () => mockFindConfigRoot(),
}));

function makeTmpDir(): string {
  const dir = join(tmpdir(), `eval-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeRunResult(overrides: Partial<EvalRunResult> = {}): EvalRunResult {
  return {
    timestamp: '2025-01-15T10:00:00.000Z',
    agent: 'test-agent',
    evaluators: ['Builtin.GoalSuccessRate'],
    lookbackDays: 7,
    sessionCount: 3,
    results: [
      {
        evaluator: 'Builtin.GoalSuccessRate',
        aggregateScore: 0.85,
        sessionScores: [{ sessionId: 's1', value: 0.85 }],
      },
    ],
    ...overrides,
  };
}

describe('storage', () => {
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

  describe('generateFilename', () => {
    it('returns a string starting with eval_', () => {
      const name = generateFilename('2025-01-15T10:30:45.000Z');
      expect(name).toMatch(/^eval_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
    });

    it('formats timestamp correctly', () => {
      const name = generateFilename('2025-03-05T08:05:09.000Z');
      expect(name).toBe('eval_2025-03-05_08-05-09');
    });
  });

  describe('saveEvalRun', () => {
    it('creates eval-results directory and writes JSON file', () => {
      const run = makeRunResult();
      const filePath = saveEvalRun(run);

      expect(filePath).toContain('eval-results');
      expect(filePath).toContain('eval_2025-01-15');
      expect(filePath.endsWith('.json')).toBe(true);
      expect(existsSync(filePath)).toBe(true);
    });

    it('writes valid JSON that can be read back', () => {
      const run = makeRunResult();
      saveEvalRun(run);
      const filename = generateFilename(run.timestamp);
      const loaded = loadEvalRun(filename);
      expect(loaded).toEqual(run);
    });
  });

  describe('loadEvalRun', () => {
    it('loads a previously saved run', () => {
      const run = makeRunResult({ agent: 'my-agent' });
      saveEvalRun(run);

      const filename = generateFilename(run.timestamp);
      const loaded = loadEvalRun(filename);
      expect(loaded.agent).toBe('my-agent');
      expect(loaded.results).toHaveLength(1);
    });

    it('accepts filename with .json extension', () => {
      const run = makeRunResult();
      saveEvalRun(run);

      const filename = generateFilename(run.timestamp);
      const loaded = loadEvalRun(`${filename}.json`);
      expect(loaded).toEqual(run);
    });

    it('throws for a non-existent filename', () => {
      expect(() => loadEvalRun('eval_2099-01-01_00-00-00')).toThrow('not found');
    });
  });

  describe('listEvalRuns', () => {
    it('returns empty array when eval-results dir does not exist', () => {
      // Point to a dir with no eval-results subdirectory
      const emptyDir = makeTmpDir();
      mockFindConfigRoot.mockReturnValue(emptyDir);

      expect(listEvalRuns()).toEqual([]);

      rmSync(emptyDir, { recursive: true, force: true });
    });

    it('returns saved runs', () => {
      saveEvalRun(makeRunResult({ timestamp: '2025-01-15T10:00:00.000Z' }));
      saveEvalRun(makeRunResult({ timestamp: '2025-01-15T11:00:00.000Z' }));

      const runs = listEvalRuns();
      expect(runs).toHaveLength(2);
    });

    it('returns runs in reverse sorted order (newest first)', () => {
      saveEvalRun(makeRunResult({ timestamp: '2025-01-15T08:00:00.000Z' }));
      saveEvalRun(makeRunResult({ timestamp: '2025-01-15T12:00:00.000Z' }));
      saveEvalRun(makeRunResult({ timestamp: '2025-01-15T10:00:00.000Z' }));

      const runs = listEvalRuns();
      const timestamps = runs.map(r => r.timestamp);
      expect(timestamps).toEqual(['2025-01-15T12:00:00.000Z', '2025-01-15T10:00:00.000Z', '2025-01-15T08:00:00.000Z']);
    });

    it('ignores files that do not match the naming pattern', async () => {
      saveEvalRun(makeRunResult());

      // Write a file that doesn't match the pattern
      const resultsDir = join(tmpDir, '.cli', 'eval-results');
      const { writeFileSync } = await import('fs');
      writeFileSync(join(resultsDir, 'notes.txt'), 'not a run');
      writeFileSync(join(resultsDir, 'other.json'), '{}');

      const runs = listEvalRuns();
      expect(runs).toHaveLength(1);
    });
  });

  describe('getResultsPath', () => {
    it('returns the eval-results directory path', () => {
      const path = getResultsPath();
      expect(path).toBe(join(tmpDir, '.cli', 'eval-results'));
    });
  });

  describe('error when no config root', () => {
    it('throws when findConfigRoot returns null', () => {
      mockFindConfigRoot.mockReturnValue(null);
      expect(() => saveEvalRun(makeRunResult())).toThrow('No agentcore project found');
    });
  });
});
