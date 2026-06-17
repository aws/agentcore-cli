import { getRecommendation } from '../../../../aws/agentcore-recommendation';
import type { GetRecommendationResult } from '../../../../aws/agentcore-recommendation';
import type { RecommendationJobRecord } from '../../shared/types';
import { recommendationHandler } from '../handler';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../aws/agentcore-recommendation', () => ({
  getRecommendation: vi.fn(),
}));

vi.mock('../../../../aws/region', () => ({
  detectRegion: vi.fn().mockResolvedValue({ region: 'us-west-2' }),
}));

const mockGet = vi.mocked(getRecommendation);

/** A record carrying a region-bearing ARN so refresh() never needs detectRegion(). */
function baseRecord(overrides: Partial<RecommendationJobRecord> = {}): RecommendationJobRecord {
  return {
    type: 'recommendation',
    id: 'rec-123',
    arn: 'arn:aws:bedrock-agentcore:us-west-2:111122223333:recommendation/rec-123',
    status: 'PENDING',
    createdAt: '2026-06-16T01:00:00.000Z',
    agent: 'MyAgent',
    recommendationType: 'SYSTEM_PROMPT_RECOMMENDATION',
    evaluators: ['Builtin.Correctness'],
    inputSource: 'inline',
    ...overrides,
  };
}

function getResult(overrides: Partial<GetRecommendationResult>): GetRecommendationResult {
  return {
    recommendationId: 'rec-123',
    recommendationArn: 'arn:aws:bedrock-agentcore:us-west-2:111122223333:recommendation/rec-123',
    name: 'rec',
    type: 'SYSTEM_PROMPT_RECOMMENDATION',
    status: 'PENDING',
    ...overrides,
  };
}

describe('recommendationHandler.refresh — completedAt only on terminal status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT set completedAt while IN_PROGRESS even though updatedAt advances', async () => {
    mockGet.mockResolvedValue(getResult({ status: 'IN_PROGRESS', updatedAt: '2026-06-16T01:00:05.000Z' }));

    const result = await recommendationHandler.refresh(baseRecord({ status: 'PENDING' }));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.record.status).toBe('IN_PROGRESS');
    // Regression: a running job must not look completed.
    expect(result.record.completedAt).toBeUndefined();
  });

  it('clears a stale completedAt left by a prior buggy refresh when still IN_PROGRESS', async () => {
    mockGet.mockResolvedValue(getResult({ status: 'IN_PROGRESS', updatedAt: '2026-06-16T01:00:05.000Z' }));

    const result = await recommendationHandler.refresh(
      baseRecord({ status: 'IN_PROGRESS', completedAt: '2026-06-16T01:00:01.000Z' })
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.record.completedAt).toBeUndefined();
  });

  it('sets completedAt from the service completedAt once COMPLETED', async () => {
    mockGet.mockResolvedValue(
      getResult({
        status: 'COMPLETED',
        completedAt: '2026-06-16T01:05:00.000Z',
        updatedAt: '2026-06-16T01:05:00.000Z',
      })
    );

    const result = await recommendationHandler.refresh(baseRecord({ status: 'IN_PROGRESS' }));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.record.status).toBe('COMPLETED');
    expect(result.record.completedAt).toBe('2026-06-16T01:05:00.000Z');
  });

  it('falls back to updatedAt for a terminal status with no completedAt (e.g. FAILED)', async () => {
    mockGet.mockResolvedValue(
      getResult({ status: 'FAILED', updatedAt: '2026-06-16T01:02:00.000Z', statusReasons: ['boom'] })
    );

    const result = await recommendationHandler.refresh(baseRecord({ status: 'IN_PROGRESS' }));

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.record.status).toBe('FAILED');
    expect(result.record.completedAt).toBe('2026-06-16T01:02:00.000Z');
  });
});
