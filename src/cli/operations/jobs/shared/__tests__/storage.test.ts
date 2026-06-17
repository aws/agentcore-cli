import { assertSafeId, deleteRecord, listRecords, loadRecord, saveRecord } from '../storage';
import type { BatchEvaluationJobRecord, RecommendationJobRecord } from '../types';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted holder so the vi.mock factory reads the current temp dir at call time.
const ctx = vi.hoisted(() => ({ root: '' }));

vi.mock('../../../../../lib', () => ({
  CLI_SYSTEM_DIR: '.cli',
  findConfigRoot: () => ctx.root,
  NoProjectError: class NoProjectError extends Error {},
}));

function rec(over: Partial<RecommendationJobRecord> = {}): RecommendationJobRecord {
  return {
    type: 'recommendation',
    id: 'rec-1',
    arn: 'arn',
    status: 'COMPLETED',
    createdAt: '2026-06-01T00:00:00Z',
    agent: 'a',
    recommendationType: 'SYSTEM_PROMPT_RECOMMENDATION',
    evaluators: [],
    inputSource: 'inline',
    ...over,
  };
}

describe('jobs storage', () => {
  beforeEach(() => {
    ctx.root = mkdtempSync(join(tmpdir(), 'jobs-storage-'));
  });
  afterEach(() => {
    rmSync(ctx.root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('round-trips a record through save → load', () => {
    const record = rec({ id: 'rec-abc' });
    saveRecord(record);
    expect(loadRecord('recommendation', 'rec-abc')).toEqual(record);
  });

  it('returns undefined for a missing record', () => {
    expect(loadRecord('recommendation', 'missing')).toBeUndefined();
  });

  it('lists records of a type and skips corrupt files without throwing', () => {
    saveRecord(rec({ id: 'good-1' }));
    saveRecord(rec({ id: 'good-2' }));
    // Drop a corrupt file into the same dir
    writeFileSync(join(ctx.root, '.cli', 'jobs', 'recommendations', 'broken.json'), '{ not valid json');
    const records = listRecords('recommendation');
    expect(records.map(r => r.id).sort()).toEqual(['good-1', 'good-2']);
  });

  it('ignores legacy-shape files (missing/wrong type discriminator)', () => {
    mkdirSync(join(ctx.root, '.cli', 'jobs', 'recommendations'), { recursive: true });
    // Legacy recommendation record: keyed on recommendationId, `type` holds a RecommendationType
    writeFileSync(
      join(ctx.root, '.cli', 'jobs', 'recommendations', 'rec-legacy.json'),
      JSON.stringify({ recommendationId: 'rec-legacy', type: 'SYSTEM_PROMPT_RECOMMENDATION', status: 'COMPLETED' })
    );
    expect(loadRecord('recommendation', 'rec-legacy')).toBeUndefined();
    expect(listRecords('recommendation')).toEqual([]);
  });

  it('deletes a record and reports whether it existed', () => {
    saveRecord(rec({ id: 'rec-del' }));
    expect(deleteRecord('recommendation', 'rec-del')).toBe(true);
    expect(deleteRecord('recommendation', 'rec-del')).toBe(false);
    expect(loadRecord('recommendation', 'rec-del')).toBeUndefined();
  });

  it('keeps recommendation and batch-evaluation records in separate directories', () => {
    saveRecord(rec({ id: 'rec-1' }));
    const be: BatchEvaluationJobRecord = {
      type: 'batch-evaluation',
      id: 'be-1',
      arn: 'arn',
      status: 'COMPLETED',
      createdAt: '2026-06-01T00:00:00Z',
      agent: 'a',
      name: 'n',
      evaluators: [],
      resultsFetched: true,
    };
    saveRecord(be);
    expect(listRecords('recommendation').map(r => r.id)).toEqual(['rec-1']);
    expect(listRecords('batch-evaluation').map(r => r.id)).toEqual(['be-1']);
  });

  it('rejects ids containing path separators', () => {
    expect(() => assertSafeId('../escape')).toThrow();
    expect(() => assertSafeId('a/b')).toThrow();
    expect(() => assertSafeId('')).toThrow();
    expect(() => assertSafeId('safe-id_123')).not.toThrow();
  });
});
