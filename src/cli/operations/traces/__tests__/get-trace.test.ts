import { fetchSpans, fetchTraceRecords, getTrace, querySpanRecords } from '../get-trace';
import type { FetchTraceRecordsOptions } from '../types';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

    assert(result.success);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toEqual({
      '@timestamp': '2024-01-01T00:00:00Z',
      '@message': { traceId: 'abc123', spanId: 'span1' },
      '@ptr': 'ptr-value-1',
    });
    expect(result.records[1]).toEqual({
      '@timestamp': '2024-01-01T00:00:01Z',
      '@message': { traceId: 'abc123', spanId: 'span2' },
    });
  });

  it('returns error for invalid trace ID format', async () => {
    const result = await fetchTraceRecords({
      ...baseOptions,
      traceId: 'invalid!@#$',
    });

    assert(!result.success);
    expect(result.error.message).toContain('Invalid trace ID format');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns error when no trace data found', async () => {
    mockSend.mockResolvedValueOnce({ queryId: 'q-1' }).mockResolvedValueOnce({
      status: 'Complete',
      results: [],
    });

    const result = await fetchTraceRecords(baseOptions);

    assert(!result.success);
    expect(result.error.message).toContain('No trace data found');
  });

  it('returns error when query fails to start', async () => {
    mockSend.mockResolvedValueOnce({ queryId: undefined });

    const result = await fetchTraceRecords(baseOptions);

    assert(!result.success);
    expect(result.error.message).toContain('Failed to start CloudWatch Logs Insights query');
  });

  it('returns error when query status is Failed', async () => {
    mockSend.mockResolvedValueOnce({ queryId: 'q-1' }).mockResolvedValueOnce({ status: 'Failed' });

    const result = await fetchTraceRecords(baseOptions);

    assert(!result.success);
    expect(result.error.message).toContain('failed');
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

    assert(result.success);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!['@ptr']).toBe('cw-ptr-123');
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

    assert(result.success);
    expect(result.records[0]).not.toHaveProperty('@ptr');
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

    assert(result.success);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]!['@message']).toBe('plain text message');
  });

  it('handles ResourceNotFoundException', async () => {
    const error = new Error('Not found');
    error.name = 'ResourceNotFoundException';
    mockSend.mockRejectedValueOnce(error);

    const result = await fetchTraceRecords(baseOptions);

    assert(!result.success);
    expect(result.error.message).toContain('Log group');
    expect(result.error.message).toContain('not found');
  });
});

describe('querySpanRecords', () => {
  afterEach(() => vi.clearAllMocks());

  it('queries a single log group and maps resource/endpoint attributes', async () => {
    const startedQueries: { logGroupName: string; queryString: string }[] = [];
    mockSend.mockImplementation((cmd: { input: Record<string, string> }) => {
      if (cmd.input.queryString) {
        startedQueries.push({ logGroupName: cmd.input.logGroupName!, queryString: cmd.input.queryString });
        return Promise.resolve({ queryId: 'q-1' });
      }
      return Promise.resolve({
        status: 'Complete',
        results: [
          [
            { field: 'traceId', value: 'abc123def456' },
            { field: 'spanId', value: 'span-1' },
            { field: 'name', value: 'POST /invocations' },
            { field: 'kind', value: 'SERVER' },
            { field: 'cloudResourceId', value: 'arn:aws:bedrock-agentcore:us-west-2:123:runtime/runtime-123/x' },
            { field: 'endpointName', value: 'test' },
            { field: 'agentId', value: 'runtime-123' },
            { field: 'traceloopSpanKind', value: 'tool' },
            { field: 'openinferenceSpanKind', value: 'TOOL' },
            { field: 'requestModel', value: 'claude-3-5-sonnet' },
            { field: 'responseModel', value: 'claude-3-5-sonnet-20241022-v2:0' },
          ],
        ],
      });
    });

    const result = await querySpanRecords({
      region: 'us-west-2',
      logGroupName: '/aws/bedrock-agentcore/runtimes/runtime-123-test',
      traceId: 'abc123def456',
    });

    assert(result.success);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({
      spanId: 'span-1',
      cloudResourceId: 'arn:aws:bedrock-agentcore:us-west-2:123:runtime/runtime-123/x',
      endpointName: 'test',
      agentId: 'runtime-123',
      traceloopSpanKind: 'tool',
      openinferenceSpanKind: 'TOOL',
      requestModel: 'claude-3-5-sonnet',
      responseModel: 'claude-3-5-sonnet-20241022-v2:0',
    });
    expect(startedQueries).toHaveLength(1);
    expect(startedQueries[0]!.logGroupName).toBe('/aws/bedrock-agentcore/runtimes/runtime-123-test');
    expect(startedQueries[0]!.queryString).toContain('resource.attributes.cloud.resource_id as cloudResourceId');
    expect(startedQueries[0]!.queryString).toContain('attributes.aws.endpoint.name as endpointName');
    expect(startedQueries[0]!.queryString).toContain('attributes.aws.agent.id as agentId');
    expect(startedQueries[0]!.queryString).toContain('attributes.traceloop.span.kind as traceloopSpanKind');
    expect(startedQueries[0]!.queryString).toContain('attributes.openinference.span.kind as openinferenceSpanKind');
    expect(startedQueries[0]!.queryString).toContain('attributes.gen_ai.request.model as requestModel');
    expect(startedQueries[0]!.queryString).toContain('attributes.gen_ai.response.model as responseModel');
  });

  it('returns error for invalid trace ID format', async () => {
    const result = await querySpanRecords({
      region: 'us-west-2',
      logGroupName: 'aws/spans',
      traceId: 'not$valid',
    });

    assert(!result.success);
    expect(result.error.message).toContain('Invalid trace ID format');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('fetchSpans', () => {
  afterEach(() => vi.clearAllMocks());

  it('maps span rows including the gen_ai operation name', async () => {
    const startedQueries: { logGroupName: string; queryString: string }[] = [];
    mockSend.mockImplementation((cmd: { input: Record<string, string> }) => {
      if (cmd.input.queryString) {
        startedQueries.push({ logGroupName: cmd.input.logGroupName!, queryString: cmd.input.queryString });
        return Promise.resolve({ queryId: cmd.input.logGroupName === 'aws/spans' ? 'q-spans' : 'q-runtime' });
      }
      if (cmd.input.queryId === 'q-spans') {
        return Promise.resolve({
          status: 'Complete',
          results: [
            [
              { field: 'traceId', value: 'abc123def456' },
              { field: 'spanId', value: 'span-1' },
              { field: 'name', value: 'chat claude' },
              { field: 'kind', value: 'CLIENT' },
              { field: 'startTimeUnixNano', value: '1700000000000000000' },
              { field: 'endTimeUnixNano', value: '1700000001000000000' },
              { field: 'inputTokens', value: '120' },
              { field: 'genAiOperation', value: 'chat' },
            ],
          ],
        });
      }
      return Promise.resolve({ status: 'Complete', results: [] });
    });

    const result = await fetchSpans('us-west-2', 'runtime-123', 'abc123def456', 1000000, 2000000);

    assert(result.success);
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({
      traceId: 'abc123def456',
      spanId: 'span-1',
      name: 'chat claude',
      kind: 'CLIENT',
      inputTokens: 120,
      genAiOperation: 'chat',
    });
    const spansQuery = startedQueries.find(q => q.logGroupName === 'aws/spans');
    expect(spansQuery?.queryString).toContain('attributes.gen_ai.operation.name as genAiOperation');
  });

  it('returns error for invalid trace ID format', async () => {
    const result = await fetchSpans('us-west-2', 'runtime-123', 'not$valid');

    assert(!result.success);
    expect(result.error.message).toContain('Invalid trace ID format');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('getTrace', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'get-trace-test-'));
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('calls fetchTraceRecords and writes result to disk', async () => {
    mockSend.mockResolvedValueOnce({ queryId: 'q-1' }).mockResolvedValueOnce({
      status: 'Complete',
      results: [
        [
          { field: '@timestamp', value: '2024-01-01T00:00:00Z' },
          { field: '@message', value: '{"traceId":"abc123"}' },
        ],
      ],
    });

    const outputPath = join(tmpDir, 'test-trace.json');
    const result = await getTrace({
      region: 'us-west-2',
      runtimeId: 'runtime-123',
      agentName: 'my-agent',
      traceId: 'abc123def456',
      outputPath,
      startTime: 1000000,
      endTime: 2000000,
    });

    assert(result.success);
    expect(result.filePath).toContain('test-trace.json');
    const content = JSON.parse(readFileSync(outputPath, 'utf-8'));
    expect(content).toHaveLength(1);
    expect(content[0]['@message']).toEqual({ traceId: 'abc123' });
  });

  it('returns error from fetchTraceRecords without writing file', async () => {
    const outputPath = join(tmpDir, 'should-not-exist.json');
    const result = await getTrace({
      region: 'us-west-2',
      runtimeId: 'runtime-123',
      agentName: 'my-agent',
      traceId: 'invalid!@#$',
      outputPath,
      startTime: 1000000,
      endTime: 2000000,
    });

    assert(!result.success);
    expect(result.error.message).toContain('Invalid trace ID format');
    expect(existsSync(outputPath)).toBe(false);
  });
});
