import { handleListEvalRuns } from '../list-eval-runs.js';
import type { EvalRunResult } from '../types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockListEvalRuns = vi.fn();

vi.mock('../storage', () => ({
  listEvalRuns: () => mockListEvalRuns(),
}));

function makeRun(agent: string, timestamp: string): EvalRunResult {
  return {
    timestamp,
    agent,
    evaluators: ['Builtin.GoalSuccessRate'],
    lookbackDays: 7,
    sessionCount: 3,
    results: [],
  };
}

describe('handleListEvalRuns', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns all runs when no filters specified', () => {
    const runs = [makeRun('agent-a', '2025-01-15T10:00:00.000Z'), makeRun('agent-b', '2025-01-15T11:00:00.000Z')];
    mockListEvalRuns.mockReturnValue(runs);

    const result = handleListEvalRuns({});

    expect(result.success).toBe(true);
    expect(result.runs).toHaveLength(2);
  });

  it('filters by agent name', () => {
    const runs = [
      makeRun('agent-a', '2025-01-15T10:00:00.000Z'),
      makeRun('agent-b', '2025-01-15T11:00:00.000Z'),
      makeRun('agent-a', '2025-01-15T12:00:00.000Z'),
    ];
    mockListEvalRuns.mockReturnValue(runs);

    const result = handleListEvalRuns({ agent: 'agent-a' });

    expect(result.success).toBe(true);
    expect(result.runs).toHaveLength(2);
    expect(result.runs!.every(r => r.agent === 'agent-a')).toBe(true);
  });

  it('limits the number of results', () => {
    const runs = [
      makeRun('a', '2025-01-15T10:00:00.000Z'),
      makeRun('a', '2025-01-15T11:00:00.000Z'),
      makeRun('a', '2025-01-15T12:00:00.000Z'),
    ];
    mockListEvalRuns.mockReturnValue(runs);

    const result = handleListEvalRuns({ limit: 2 });

    expect(result.success).toBe(true);
    expect(result.runs).toHaveLength(2);
  });

  it('applies agent filter before limit', () => {
    const runs = [
      makeRun('a', '2025-01-15T10:00:00.000Z'),
      makeRun('b', '2025-01-15T11:00:00.000Z'),
      makeRun('a', '2025-01-15T12:00:00.000Z'),
      makeRun('a', '2025-01-15T13:00:00.000Z'),
    ];
    mockListEvalRuns.mockReturnValue(runs);

    const result = handleListEvalRuns({ agent: 'a', limit: 2 });

    expect(result.runs).toHaveLength(2);
    expect(result.runs![0]!.timestamp).toBe('2025-01-15T10:00:00.000Z');
    expect(result.runs![1]!.timestamp).toBe('2025-01-15T12:00:00.000Z');
  });

  it('returns empty array when no runs exist', () => {
    mockListEvalRuns.mockReturnValue([]);

    const result = handleListEvalRuns({});

    expect(result.success).toBe(true);
    expect(result.runs).toEqual([]);
  });

  it('returns error when storage throws', () => {
    mockListEvalRuns.mockImplementation(() => {
      throw new Error('disk error');
    });

    const result = handleListEvalRuns({});

    expect(result.success).toBe(false);
    expect(result.error).toBe('disk error');
    expect(result.runs).toBeUndefined();
  });

  it('handles non-Error thrown values', () => {
    mockListEvalRuns.mockImplementation(() => {
      throw new Error('42');
    });

    const result = handleListEvalRuns({});

    expect(result.success).toBe(false);
    expect(result.error).toBe('42');
  });
});
