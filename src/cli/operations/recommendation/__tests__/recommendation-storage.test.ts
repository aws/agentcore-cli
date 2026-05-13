import { listAllRecommendations, loadRecommendationRun, saveRecommendationRun } from '../recommendation-storage';
import type { RunRecommendationCommandResult } from '../types';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindConfigRoot = vi.fn();

vi.mock('../../../../lib', () => ({
  findConfigRoot: () => mockFindConfigRoot(),
}));

function makeTmpDir(): string {
  const dir = join(tmpdir(), `recommendation-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeResult(
  overrides: Partial<Extract<RunRecommendationCommandResult, { success: true }>> = {}
): RunRecommendationCommandResult {
  return {
    success: true,
    recommendationId: 'rec-123',
    status: 'COMPLETED',
    startedAt: '2026-03-24T10:00:00.000Z',
    completedAt: '2026-03-24T10:05:00.000Z',
    result: {
      systemPromptRecommendationResult: {
        recommendedSystemPrompt: 'You are an expert booking assistant.',
      },
    },
    ...overrides,
  };
}

describe('recommendation-storage', () => {
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

  describe('saveRecommendationRun', () => {
    it('creates directory and writes JSON file', () => {
      const result = makeResult();
      const filePath = saveRecommendationRun('rec-123', result, 'SYSTEM_PROMPT_RECOMMENDATION', 'booking-agent', [
        'Builtin.Helpfulness',
      ]);

      expect(filePath).toContain('recommendations');
      expect(filePath).toContain('rec-123.json');
      expect(existsSync(filePath)).toBe(true);
    });

    it('writes valid JSON that can be read back', () => {
      const result = makeResult();
      saveRecommendationRun('rec-123', result, 'SYSTEM_PROMPT_RECOMMENDATION', 'booking-agent', [
        'Builtin.Helpfulness',
      ]);

      const loaded = loadRecommendationRun('rec-123');
      expect(loaded.recommendationId).toBe('rec-123');
      expect(loaded.type).toBe('SYSTEM_PROMPT_RECOMMENDATION');
      expect(loaded.agent).toBe('booking-agent');
      expect(loaded.evaluators).toEqual(['Builtin.Helpfulness']);
      expect(loaded.result?.systemPromptRecommendationResult?.recommendedSystemPrompt).toBe(
        'You are an expert booking assistant.'
      );
    });
  });

  describe('loadRecommendationRun', () => {
    it('loads a previously saved recommendation', () => {
      saveRecommendationRun('rec-123', makeResult(), 'SYSTEM_PROMPT_RECOMMENDATION', 'agent', ['eval']);
      const loaded = loadRecommendationRun('rec-123');
      expect(loaded.status).toBe('COMPLETED');
    });

    it('accepts filename with .json extension', () => {
      saveRecommendationRun('rec-123', makeResult(), 'SYSTEM_PROMPT_RECOMMENDATION', 'agent', ['eval']);
      const loaded = loadRecommendationRun('rec-123.json');
      expect(loaded.recommendationId).toBe('rec-123');
    });

    it('throws for a non-existent recommendation', () => {
      expect(() => loadRecommendationRun('nonexistent')).toThrow('not found');
    });
  });

  describe('listAllRecommendations', () => {
    it('returns empty array when no recommendations exist', () => {
      expect(listAllRecommendations()).toEqual([]);
    });

    it('returns saved recommendations in reverse order', () => {
      saveRecommendationRun(
        'rec-aaa',
        makeResult({ recommendationId: 'rec-aaa' }),
        'SYSTEM_PROMPT_RECOMMENDATION',
        'agent',
        ['eval']
      );
      saveRecommendationRun(
        'rec-zzz',
        makeResult({ recommendationId: 'rec-zzz' }),
        'TOOL_DESCRIPTION_RECOMMENDATION',
        'agent',
        ['eval']
      );

      const all = listAllRecommendations();
      expect(all).toHaveLength(2);
      expect(all[0]!.recommendationId).toBe('rec-zzz');
      expect(all[1]!.recommendationId).toBe('rec-aaa');
    });
  });

  describe('error when no config root', () => {
    it('throws when findConfigRoot returns null', () => {
      mockFindConfigRoot.mockReturnValue(null);
      expect(() =>
        saveRecommendationRun('rec-123', makeResult(), 'SYSTEM_PROMPT_RECOMMENDATION', 'agent', ['eval'])
      ).toThrow('No agentcore project found');
    });
  });
});
