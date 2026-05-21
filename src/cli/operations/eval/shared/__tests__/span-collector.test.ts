import { collectSpans, extractTraceIds } from '../span-collector';
import type { DocumentType } from '@smithy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('extractTraceIds', () => {
  it('extracts unique traceIds in appearance order', () => {
    const spans = [
      { traceId: 'a', spanId: '1' },
      { traceId: 'b', spanId: '2' },
      { traceId: 'a', spanId: '3' }, // duplicate
      { traceId: 'c', spanId: '4' },
    ];

    const result = extractTraceIds(spans);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array for no spans', () => {
    expect(extractTraceIds([])).toEqual([]);
  });

  it('skips spans without traceId', () => {
    const spans = [{ spanId: '1' }, { traceId: 'a', spanId: '2' }, { other: 'x' }] as unknown as DocumentType[];
    expect(extractTraceIds(spans)).toEqual(['a']);
  });
});

describe('collectSpans', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns spans for all sessions after polling', async () => {
    const mockQuerySpans = vi.fn().mockImplementation((_r, _l, sessionId) => {
      return Promise.resolve([{ traceId: `trace-${sessionId}`, spanId: 'sp1' }]);
    });

    const promise = collectSpans({
      sessionIds: ['sess-1', 'sess-2'],
      region: 'us-east-1',
      logGroup: '/aws/spans',
      querySpans: mockQuerySpans,
    });

    // Advance past ingestion delay
    await vi.advanceTimersByTimeAsync(180_000);
    // Advance past one poll interval to let the query resolve
    await vi.advanceTimersByTimeAsync(5_000);

    const result = await promise;

    expect(result.spans.size).toBe(2);
    expect(result.timedOut).toHaveLength(0);
    expect(result.spans.get('sess-1')).toHaveLength(1);
    expect(result.spans.get('sess-2')).toHaveLength(1);
  });

  it('reports timed-out sessions', async () => {
    const mockQuerySpans = vi.fn().mockImplementation((_r, _l, sessionId) => {
      // sess-1 always returns empty (simulates missing spans)
      if (sessionId === 'sess-1') return Promise.resolve([]);
      return Promise.resolve([{ traceId: 'trace-2' }]);
    });

    const promise = collectSpans({
      sessionIds: ['sess-1', 'sess-2'],
      region: 'us-east-1',
      logGroup: '/aws/spans',
      querySpans: mockQuerySpans,
    });

    // Advance past ingestion delay + full poll timeout
    await vi.advanceTimersByTimeAsync(180_000 + 60_000 + 5_000);

    const result = await promise;

    expect(result.spans.has('sess-2')).toBe(true);
    expect(result.timedOut).toContain('sess-1');
  });

  it('retries on transient errors', async () => {
    let calls = 0;
    const mockQuerySpans = vi.fn().mockImplementation(() => {
      calls++;
      if (calls <= 2) throw new Error('Service unavailable');
      return Promise.resolve([{ traceId: 'trace-1' }]);
    });

    const promise = collectSpans({
      sessionIds: ['sess-1'],
      region: 'us-east-1',
      logGroup: '/aws/spans',
      querySpans: mockQuerySpans,
    });

    // Advance past ingestion delay + enough poll intervals for retry
    await vi.advanceTimersByTimeAsync(180_000 + 180_000);

    const result = await promise;

    expect(result.spans.has('sess-1')).toBe(true);
    expect(result.timedOut).toHaveLength(0);
  });

  it('calls onProgress with ingestion delay message', async () => {
    const onProgress = vi.fn();
    const mockQuerySpans = vi.fn().mockResolvedValue([{ traceId: 't1' }]);

    const promise = collectSpans({
      sessionIds: ['sess-1'],
      region: 'us-east-1',
      logGroup: '/aws/spans',
      querySpans: mockQuerySpans,
      onProgress,
    });

    await vi.advanceTimersByTimeAsync(180_000 + 5_000);
    await promise;

    // First call should be the ingestion delay message
    expect(onProgress).toHaveBeenCalledWith(0, 1, expect.stringContaining('Waiting for span ingestion'));
  });
});
