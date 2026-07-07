import { type RetrieveMemoryRecordsOptions, retrieveMemoryRecords } from '../retrieve-memory-records';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockSend, capturedInput } = vi.hoisted(() => {
  const captured: { value: unknown } = { value: null };
  return {
    mockSend: vi.fn(),
    capturedInput: captured,
  };
});

vi.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: class {
    send = mockSend;
  },
  RetrieveMemoryRecordsCommand: class {
    constructor(public input: unknown) {
      capturedInput.value = input;
    }
  },
}));

vi.mock('../../../aws', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

describe('retrieveMemoryRecords', () => {
  afterEach(() => {
    vi.clearAllMocks();
    capturedInput.value = null;
  });

  it('rejects when both namespace and namespacePath are provided', async () => {
    const options = {
      region: 'us-west-2',
      memoryId: 'mem-1',
      namespace: '/a/',
      namespacePath: '/b/',
      searchQuery: 'q',
    } as unknown as RetrieveMemoryRecordsOptions;

    const result = await retrieveMemoryRecords(options);

    expect(result.success).toBe(false);
    expect((result as { error: Error }).error.message).toContain('mutually exclusive');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects when neither namespace nor namespacePath is provided', async () => {
    const options = {
      region: 'us-west-2',
      memoryId: 'mem-1',
      searchQuery: 'q',
    } as unknown as RetrieveMemoryRecordsOptions;

    const result = await retrieveMemoryRecords(options);

    expect(result.success).toBe(false);
    expect((result as { error: Error }).error.message).toContain('Either');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects when namespace is an empty string (treated as not provided)', async () => {
    const options = {
      region: 'us-west-2',
      memoryId: 'mem-1',
      namespace: '',
      searchQuery: 'q',
    } as unknown as RetrieveMemoryRecordsOptions;

    const result = await retrieveMemoryRecords(options);

    expect(result.success).toBe(false);
    expect((result as { error: Error }).error.message).toContain('Either');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('forwards namespace to the SDK when only namespace is provided', async () => {
    mockSend.mockResolvedValueOnce({ memoryRecordSummaries: [], nextToken: undefined });

    const result = await retrieveMemoryRecords({
      region: 'us-west-2',
      memoryId: 'mem-1',
      namespace: '/users/42/facts',
      searchQuery: 'preferences',
      topK: 5,
    });

    expect(result.success).toBe(true);
    expect(capturedInput.value).toMatchObject({
      memoryId: 'mem-1',
      namespace: '/users/42/facts',
      searchCriteria: { searchQuery: 'preferences', topK: 5 },
    });
    expect((capturedInput.value as { namespacePath?: string }).namespacePath).toBeUndefined();
  });

  it('forwards namespacePath to the SDK when only namespacePath is provided', async () => {
    mockSend.mockResolvedValueOnce({ memoryRecordSummaries: [], nextToken: undefined });

    const result = await retrieveMemoryRecords({
      region: 'us-west-2',
      memoryId: 'mem-1',
      namespacePath: '/users/42/',
      searchQuery: 'preferences',
    });

    expect(result.success).toBe(true);
    expect(capturedInput.value).toMatchObject({
      memoryId: 'mem-1',
      namespacePath: '/users/42/',
      searchCriteria: { searchQuery: 'preferences' },
    });
    expect((capturedInput.value as { namespace?: string }).namespace).toBeUndefined();
  });

  it('parses memory record summaries into the result shape', async () => {
    const createdAt = new Date('2026-05-13T00:00:00Z');
    mockSend.mockResolvedValueOnce({
      memoryRecordSummaries: [
        {
          memoryRecordId: 'rec-1',
          content: { text: 'found you' },
          memoryStrategyId: 'strat-1',
          namespaces: ['/users/42/facts'],
          createdAt,
          score: 0.5,
          metadata: { origin: { stringValue: 'search' } },
        },
      ],
      nextToken: undefined,
    });

    const result = await retrieveMemoryRecords({
      region: 'us-west-2',
      memoryId: 'mem-1',
      namespacePath: '/users/42/',
      searchQuery: 'q',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.records).toEqual([
      {
        memoryRecordId: 'rec-1',
        content: 'found you',
        memoryStrategyId: 'strat-1',
        namespaces: ['/users/42/facts'],
        createdAt: createdAt.toISOString(),
        score: 0.5,
        metadata: { origin: 'search' },
      },
    ]);
  });

  it('maps ResourceNotFoundException to a user-friendly error', async () => {
    const err = new Error('not found');
    err.name = 'ResourceNotFoundException';
    mockSend.mockRejectedValueOnce(err);

    const result = await retrieveMemoryRecords({
      region: 'us-west-2',
      memoryId: 'missing',
      namespace: '/a/',
      searchQuery: 'q',
    });

    expect(result.success).toBe(false);
    expect((result as { error: Error }).error.message).toContain("Memory 'missing' not found");
  });

  it('returns the SDK error message for other failures', async () => {
    mockSend.mockRejectedValueOnce(new Error('network down'));

    const result = await retrieveMemoryRecords({
      region: 'us-west-2',
      memoryId: 'mem-1',
      namespace: '/a/',
      searchQuery: 'q',
    });

    expect(result.success).toBe(false);
    expect((result as { error: Error }).error.message).toBe('network down');
  });
});
