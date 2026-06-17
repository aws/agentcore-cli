import { createJobEngine } from '../engine';
import type { BatchEvaluationJobRecord, RecommendationJobRecord } from '../types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks (hoisted so the vi.mock factories below can reference them) ─────────
const { store, recHandler, batchHandler, mockValidateCreds } = vi.hoisted(() => ({
  store: { saveRecord: vi.fn(), loadRecord: vi.fn(), listRecords: vi.fn(), deleteRecord: vi.fn() },
  recHandler: { create: vi.fn(), refresh: vi.fn(), settle: vi.fn(), archive: vi.fn() },
  batchHandler: { create: vi.fn(), refresh: vi.fn(), stop: vi.fn(), archive: vi.fn() },
  mockValidateCreds: vi.fn(),
}));

vi.mock('../storage', () => ({
  saveRecord: (...a: unknown[]) => store.saveRecord(...a),
  loadRecord: (...a: unknown[]) => store.loadRecord(...a),
  listRecords: (...a: unknown[]) => store.listRecords(...a),
  deleteRecord: (...a: unknown[]) => store.deleteRecord(...a),
}));
vi.mock('../../recommendation/handler', () => ({ recommendationHandler: recHandler }));
vi.mock('../../batch-evaluation/handler', () => ({ batchEvaluationHandler: batchHandler }));
vi.mock('../../../../aws/account', () => ({ validateAwsCredentials: (...a: unknown[]) => mockValidateCreds(...a) }));
vi.mock('../../../../../lib', () => ({
  ConfigIO: function () {
    return {};
  },
  JobNotFoundError: class JobNotFoundError extends Error {},
}));

function recRecord(over: Partial<RecommendationJobRecord> = {}): RecommendationJobRecord {
  return {
    type: 'recommendation',
    id: 'rec-1',
    arn: 'arn:aws:bedrock-agentcore:us-west-2:111122223333:recommendation/rec-1',
    status: 'PENDING',
    createdAt: '2026-06-01T00:00:00Z',
    agent: 'myagent',
    recommendationType: 'SYSTEM_PROMPT_RECOMMENDATION',
    evaluators: ['Builtin.Correctness'],
    inputSource: 'inline',
    ...over,
  };
}

function batchRecord(over: Partial<BatchEvaluationJobRecord> = {}): BatchEvaluationJobRecord {
  return {
    type: 'batch-evaluation',
    id: 'be-1',
    arn: 'arn:aws:bedrock-agentcore:us-west-2:111122223333:batch-evaluation/be-1',
    status: 'IN_PROGRESS',
    createdAt: '2026-06-01T00:00:00Z',
    agent: 'myagent',
    name: 'run1',
    evaluators: ['Builtin.Correctness'],
    ...over,
  };
}

describe('createJobEngine', () => {
  beforeEach(() => {
    mockValidateCreds.mockResolvedValue(undefined);
    recHandler.settle.mockImplementation((r: RecommendationJobRecord) => Promise.resolve(r));
  });
  afterEach(() => vi.clearAllMocks());

  describe('start', () => {
    it('validates credentials, calls handler.create, and saves the record', async () => {
      const record = recRecord();
      recHandler.create.mockResolvedValue({ success: true, record });
      const engine = createJobEngine();

      const result = await engine.start('recommendation', {
        type: 'SYSTEM_PROMPT_RECOMMENDATION',
        agent: 'myagent',
        evaluators: ['Builtin.Correctness'],
        inputSource: 'inline',
        traceSource: 'cloudwatch',
      });

      expect(mockValidateCreds).toHaveBeenCalled();
      expect(recHandler.create).toHaveBeenCalled();
      expect(store.saveRecord).toHaveBeenCalledWith(record);
      expect(result.success).toBe(true);
    });

    it('does not save when credentials are invalid', async () => {
      mockValidateCreds.mockRejectedValue(new Error('expired token'));
      const engine = createJobEngine();
      const result = await engine.start('recommendation', {
        type: 'SYSTEM_PROMPT_RECOMMENDATION',
        agent: 'a',
        evaluators: [],
        inputSource: 'inline',
        traceSource: 'cloudwatch',
      });
      expect(result.success).toBe(false);
      expect(recHandler.create).not.toHaveBeenCalled();
      expect(store.saveRecord).not.toHaveBeenCalled();
    });

    it('does not save when create fails', async () => {
      recHandler.create.mockResolvedValue({ success: false, error: new Error('bad input') });
      const engine = createJobEngine();
      const result = await engine.start('recommendation', {
        type: 'SYSTEM_PROMPT_RECOMMENDATION',
        agent: 'a',
        evaluators: ['Builtin.Correctness'],
        inputSource: 'inline',
        traceSource: 'cloudwatch',
      });
      expect(result.success).toBe(false);
      expect(store.saveRecord).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('returns a terminal record without refreshing', async () => {
      store.loadRecord.mockReturnValue(recRecord({ status: 'COMPLETED' }));
      const engine = createJobEngine();
      const record = await engine.get('recommendation', 'rec-1');
      expect(record?.status).toBe('COMPLETED');
      expect(recHandler.refresh).not.toHaveBeenCalled();
    });

    it('refreshes a non-terminal record and saves the update', async () => {
      store.loadRecord.mockReturnValue(recRecord({ status: 'IN_PROGRESS' }));
      recHandler.refresh.mockResolvedValue({ success: true, record: recRecord({ status: 'COMPLETED' }) });
      const engine = createJobEngine();
      const record = await engine.get('recommendation', 'rec-1');
      expect(recHandler.refresh).toHaveBeenCalled();
      expect(store.saveRecord).toHaveBeenCalled();
      expect(record?.status).toBe('COMPLETED');
    });

    it('persists error after refresh retries exhausted', async () => {
      store.loadRecord.mockReturnValue(recRecord({ status: 'IN_PROGRESS' }));
      recHandler.refresh.mockResolvedValue({ success: false, error: new Error('transient network error') });
      const engine = createJobEngine();
      const record = await engine.get('recommendation', 'rec-1');
      expect(record?.error).toBe('transient network error');
    });

    it('returns undefined for a missing record', async () => {
      store.loadRecord.mockReturnValue(undefined);
      const engine = createJobEngine();
      expect(await engine.get('recommendation', 'nope')).toBeUndefined();
    });

    it('runs settle() after refresh for recommendations', async () => {
      store.loadRecord.mockReturnValue(recRecord({ status: 'IN_PROGRESS' }));
      const completed = recRecord({ status: 'COMPLETED' });
      recHandler.refresh.mockResolvedValue({ success: true, record: completed });
      recHandler.settle.mockResolvedValue(recRecord({ status: 'COMPLETED', syncedVersionId: 'v2' }));
      const engine = createJobEngine();
      const record = await engine.get('recommendation', 'rec-1');
      expect(recHandler.settle).toHaveBeenCalled();
      expect(record!.syncedVersionId).toBe('v2');
    });
  });

  describe('list', () => {
    it('refreshes non-terminal records and sorts by createdAt desc', async () => {
      store.listRecords.mockReturnValue([
        recRecord({ id: 'old', status: 'COMPLETED', createdAt: '2026-06-01T00:00:00Z' }),
        recRecord({ id: 'new', status: 'COMPLETED', createdAt: '2026-06-03T00:00:00Z' }),
      ]);
      const engine = createJobEngine();
      const records = await engine.list({ type: 'recommendation' });
      expect(records.map(r => r.id)).toEqual(['new', 'old']);
    });

    it('persists error when refresh fails for a list item', async () => {
      store.listRecords.mockReturnValue([
        recRecord({ id: 'a', status: 'IN_PROGRESS' }),
        recRecord({ id: 'b', status: 'COMPLETED' }),
      ]);
      recHandler.refresh.mockResolvedValue({ success: false, error: new Error('boom') });
      const engine = createJobEngine();
      const records = await engine.list({ type: 'recommendation' });
      expect(records).toHaveLength(2);
      expect(records.find(r => r.id === 'a')?.error).toBe('boom');
    });

    it('applies limit', async () => {
      store.listRecords.mockReturnValue([
        recRecord({ id: 'a', status: 'COMPLETED', createdAt: '2026-06-03T00:00:00Z' }),
        recRecord({ id: 'b', status: 'COMPLETED', createdAt: '2026-06-02T00:00:00Z' }),
        recRecord({ id: 'c', status: 'COMPLETED', createdAt: '2026-06-01T00:00:00Z' }),
      ]);
      const engine = createJobEngine();
      const records = await engine.list({ type: 'recommendation', limit: 2 });
      expect(records.map(r => r.id)).toEqual(['a', 'b']);
    });
  });

  describe('stop', () => {
    it('calls the handler stop and records STOPPING on success', async () => {
      store.loadRecord.mockReturnValue(batchRecord());
      batchHandler.stop.mockResolvedValue({ success: true });
      const engine = createJobEngine();
      const result = await engine.stop('batch-evaluation', 'be-1');
      expect(batchHandler.stop).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(store.saveRecord).toHaveBeenCalledWith(expect.objectContaining({ status: 'STOPPING' }));
    });

    it('returns not-found for a missing record', async () => {
      store.loadRecord.mockReturnValue(undefined);
      const engine = createJobEngine();
      const result = await engine.stop('batch-evaluation', 'nope');
      expect(result.success).toBe(false);
    });
  });

  describe('archive', () => {
    it('deletes the local record after a successful service delete', async () => {
      store.loadRecord.mockReturnValue(recRecord());
      recHandler.archive.mockResolvedValue({ success: true });
      const engine = createJobEngine();
      const result = await engine.archive('recommendation', 'rec-1');
      expect(recHandler.archive).toHaveBeenCalled();
      expect(store.deleteRecord).toHaveBeenCalledWith('recommendation', 'rec-1');
      expect(result.success).toBe(true);
    });

    it('does not delete locally when the service delete fails', async () => {
      store.loadRecord.mockReturnValue(recRecord());
      recHandler.archive.mockResolvedValue({ success: false, error: new Error('nope') });
      const engine = createJobEngine();
      const result = await engine.archive('recommendation', 'rec-1');
      expect(store.deleteRecord).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });
  });

  describe('capabilities', () => {
    it('reports batch-evaluation as stoppable and recommendation as not', () => {
      const engine = createJobEngine();
      expect(engine.capabilities('batch-evaluation').canStop).toBe(true);
      expect(engine.capabilities('recommendation').canStop).toBe(false);
    });

    it('reports ab-test as stoppable, pausable, promotable, and debuggable', () => {
      const engine = createJobEngine();
      const caps = engine.capabilities('ab-test');
      expect(caps).toEqual({ canStop: true, canPause: true, canPromote: true, canDebug: true });
    });
  });
});
