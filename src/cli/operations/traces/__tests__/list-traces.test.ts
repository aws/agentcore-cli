import { listTraces } from '../list-traces';
import type { ListTracesOptions } from '../types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockRunInsightsQuery } = vi.hoisted(() => ({
  mockRunInsightsQuery: vi.fn(),
}));

vi.mock('../insights-query', () => ({
  runInsightsQuery: mockRunInsightsQuery,
}));

const baseOptions: ListTracesOptions = {
  region: 'us-west-2',
  runtimeId: 'runtime-123',
  agentName: 'my-agent',
  startTime: 1000000,
  endTime: 2000000,
};

describe('listTraces', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns trace entries from query results', async () => {
    mockRunInsightsQuery.mockResolvedValueOnce({
      success: true,
      rows: [
        {
          traceId: 'trace-1',
          lastSeen: '2024-01-01T00:05:00Z',
          firstSeen: '2024-01-01T00:00:00Z',
          spanCount: '12',
          sessionId: 'sess-1',
        },
        { traceId: 'trace-2', lastSeen: '2024-01-01T00:03:00Z', firstSeen: '2024-01-01T00:01:00Z', spanCount: '5' },
      ],
    });

    const result = await listTraces(baseOptions);

    expect(result.success).toBe(true);
    expect(result.traces).toHaveLength(2);
    expect(result.traces![0]).toEqual({
      traceId: 'trace-1',
      timestamp: '2024-01-01T00:05:00Z',
      sessionId: 'sess-1',
      spanCount: '12',
    });
    expect(result.traces![1]).toEqual({
      traceId: 'trace-2',
      timestamp: '2024-01-01T00:03:00Z',
      sessionId: undefined,
      spanCount: '5',
    });
  });

  it('filters out rows without traceId', async () => {
    mockRunInsightsQuery.mockResolvedValueOnce({
      success: true,
      rows: [
        { traceId: 'trace-1', lastSeen: '2024-01-01T00:00:00Z', spanCount: '3' },
        { lastSeen: '2024-01-01T00:00:00Z', spanCount: '1' },
        { traceId: '', lastSeen: '2024-01-01T00:00:00Z', spanCount: '2' },
      ],
    });

    const result = await listTraces(baseOptions);

    expect(result.success).toBe(true);
    expect(result.traces).toHaveLength(1);
    expect(result.traces![0]!.traceId).toBe('trace-1');
  });

  it('falls back to firstSeen when lastSeen is missing', async () => {
    mockRunInsightsQuery.mockResolvedValueOnce({
      success: true,
      rows: [{ traceId: 'trace-1', firstSeen: '2024-01-01T00:00:00Z', spanCount: '1' }],
    });

    const result = await listTraces(baseOptions);

    expect(result.success).toBe(true);
    expect(result.traces![0]!.timestamp).toBe('2024-01-01T00:00:00Z');
  });

  it('returns empty traces for empty query results', async () => {
    mockRunInsightsQuery.mockResolvedValueOnce({
      success: true,
      rows: [],
    });

    const result = await listTraces(baseOptions);

    expect(result.success).toBe(true);
    expect(result.traces).toHaveLength(0);
  });

  it('propagates errors from runInsightsQuery', async () => {
    mockRunInsightsQuery.mockResolvedValueOnce({
      success: false,
      error: 'Log group not found',
    });

    const result = await listTraces(baseOptions);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Log group not found');
  });

  it('passes correct log group name and default limit', async () => {
    mockRunInsightsQuery.mockResolvedValueOnce({ success: true, rows: [] });

    await listTraces(baseOptions);

    expect(mockRunInsightsQuery).toHaveBeenCalledWith({
      region: 'us-west-2',
      logGroupName: '/aws/bedrock-agentcore/runtimes/runtime-123-DEFAULT',
      startTime: 1000000,
      endTime: 2000000,
      queryString: expect.stringContaining('limit 20'),
    });
  });

  it('respects custom limit', async () => {
    mockRunInsightsQuery.mockResolvedValueOnce({ success: true, rows: [] });

    await listTraces({ ...baseOptions, limit: 50 });

    expect(mockRunInsightsQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryString: expect.stringContaining('limit 50'),
      })
    );
  });
});
