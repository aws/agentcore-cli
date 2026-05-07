import { fetchTraceRecords, getTrace } from '../get-trace';
import type { FetchTraceRecordsOptions } from '../types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-cloudwatch-logs', () => ({
  CloudWatchLogsClient: class {
    send = mockSend;
  },
  StartQueryCommand: class {
    constructor(public input: unknown) {}
  },
  GetQueryResultsCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('../../../aws', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

const baseOptions: FetchTraceRecordsOptions = {
  region: 'us-west-2',
  runtimeId: 'runtime-123',
  traceId: 'abc123def456',
  startTime: 1000000,
  endTime: 2000000,
};

describe('fetchTraceRecords', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns parsed trace records from CloudWatch', async () => {
    mockSend
      .mockResolvedValueOnce({ queryId: 'q-1' }) // StartQueryCommand
      .mockResolvedValueOnce({
        // GetQueryResultsCommand
        status: 'Complete',
        results: [
          [
            { field: '@timestamp', value: '2024-01-01T00:00:00Z' },
            { field: '@message', value: '{"traceId":"abc123","spanId":"span1"}' },
            { field: '@ptr', value: 'ptr-value-1' },
          ],
          [
            { field: '@timestamp', value: '2024-01-01T00:00:01Z' },
            { field: '@message', value: '{"traceId":"abc123","spanId":"span2"}' },
          ],
        ],
      });

    const result = await fetchTraceRecords(baseOptions);

    expect(result.success).toBe(true);
    expect(result.records).toHaveLength(2);
    expect(result.records![0]).toEqual({
      '@timestamp': '2024-01-01T00:00:00Z',
      '@message': { traceId: 'abc123', spanId: 'span1' },
      '@ptr': 'ptr-value-1',
    });
    expect(result.records![1]).toEqual({
      '@timestamp': '2024-01-01T00:00:01Z',
      '@message': { traceId: 'abc123', spanId: 'span2' },
    });
  });

  it('returns error for invalid trace ID format', async () => {
    const result = await fetchTraceRecords({
      ...baseOptions,
      traceId: 'invalid!@#$',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid trace ID format');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns error when no trace data found', async () => {
    mockSend.mockResolvedValueOnce({ queryId: 'q-1' }).mockResolvedValueOnce({
      status: 'Complete',
      results: [],
    });

    const result = await fetchTraceRecords(baseOptions);

    expect(result.success).toBe(false);
    expect(result.error).toContain('No trace data found');
  });

  it('returns error when query fails to start', async () => {
    mockSend.mockResolvedValueOnce({ queryId: undefined });

    const result = await fetchTraceRecords(baseOptions);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to start CloudWatch Logs Insights query');
  });

  it('returns error when query status is Failed', async () => {
    mockSend.mockResolvedValueOnce({ queryId: 'q-1' }).mockResolvedValueOnce({ status: 'Failed' });

    const result = await fetchTraceRecords(baseOptions);

    expect(result.success).toBe(false);
    expect(result.error).toContain('failed');
  });

  it('preserves @ptr when present in CloudWatch response', async () => {
    mockSend.mockResolvedValueOnce({ queryId: 'q-1' }).mockResolvedValueOnce({
      status: 'Complete',
      results: [
        [
          { field: '@timestamp', value: '2024-01-01T00:00:00Z' },
          { field: '@message', value: '{"key":"val"}' },
          { field: '@ptr', value: 'cw-ptr-123' },
        ],
      ],
    });

    const result = await fetchTraceRecords(baseOptions);

    expect(result.success).toBe(true);
    expect(result.records).toHaveLength(1);
    expect(result.records![0]!['@ptr']).toBe('cw-ptr-123');
  });

  it('omits @ptr when not present in CloudWatch response', async () => {
    mockSend.mockResolvedValueOnce({ queryId: 'q-1' }).mockResolvedValueOnce({
      status: 'Complete',
      results: [
        [
          { field: '@timestamp', value: '2024-01-01T00:00:00Z' },
          { field: '@message', value: '{"key":"val"}' },
        ],
      ],
    });

    const result = await fetchTraceRecords(baseOptions);

    expect(result.success).toBe(true);
    expect(result.records![0]).not.toHaveProperty('@ptr');
  });

  it('handles non-JSON @message gracefully', async () => {
    mockSend.mockResolvedValueOnce({ queryId: 'q-1' }).mockResolvedValueOnce({
      status: 'Complete',
      results: [
        [
          { field: '@timestamp', value: '2024-01-01T00:00:00Z' },
          { field: '@message', value: 'plain text message' },
        ],
      ],
    });

    const result = await fetchTraceRecords(baseOptions);

    expect(result.success).toBe(true);
    expect(result.records).toHaveLength(1);
    expect(result.records![0]!['@message']).toBe('plain text message');
  });

  it('handles ResourceNotFoundException', async () => {
    const error = new Error('Not found');
    error.name = 'ResourceNotFoundException';
    mockSend.mockRejectedValueOnce(error);

    const result = await fetchTraceRecords(baseOptions);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Log group');
    expect(result.error).toContain('not found');
  });
});

describe('getTrace', () => {
  afterEach(() => vi.clearAllMocks());

  it('calls fetchTraceRecords and writes result to disk', async () => {
    const fs = await import('node:fs');

    mockSend.mockResolvedValueOnce({ queryId: 'q-1' }).mockResolvedValueOnce({
      status: 'Complete',
      results: [
        [
          { field: '@timestamp', value: '2024-01-01T00:00:00Z' },
          { field: '@message', value: '{"traceId":"abc123"}' },
        ],
      ],
    });

    const result = await getTrace({
      region: 'us-west-2',
      runtimeId: 'runtime-123',
      agentName: 'my-agent',
      traceId: 'abc123def456',
      outputPath: '/tmp/test-trace.json',
      startTime: 1000000,
      endTime: 2000000,
    });

    expect(result.success).toBe(true);
    expect(result.filePath).toContain('test-trace.json');
    expect(fs.default.mkdirSync).toHaveBeenCalled();
    expect(fs.default.writeFileSync).toHaveBeenCalledWith('/tmp/test-trace.json', expect.stringContaining('"traceId"'));
  });

  it('returns error from fetchTraceRecords without writing file', async () => {
    const fs = await import('node:fs');

    const result = await getTrace({
      region: 'us-west-2',
      runtimeId: 'runtime-123',
      agentName: 'my-agent',
      traceId: 'invalid!@#$',
      startTime: 1000000,
      endTime: 2000000,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid trace ID format');
    expect(fs.default.writeFileSync).not.toHaveBeenCalled();
  });
});
