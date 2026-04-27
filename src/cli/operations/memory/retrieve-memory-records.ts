import { getCredentialProvider } from '../../aws';
import type { MemoryRecordEntry } from './list-memory-records';
import { BedrockAgentCoreClient, RetrieveMemoryRecordsCommand } from '@aws-sdk/client-bedrock-agentcore';

export interface RetrieveMemoryRecordsOptions {
  region: string;
  memoryId: string;
  namespace: string;
  searchQuery: string;
  memoryStrategyId?: string;
  topK?: number;
  maxResults?: number;
  nextToken?: string;
}

export interface RetrieveMemoryRecordsResult {
  success: boolean;
  records?: MemoryRecordEntry[];
  nextToken?: string;
  error?: string;
}

/**
 * Searches memory records using semantic retrieval via the AWS SDK.
 */
export async function retrieveMemoryRecords(
  options: RetrieveMemoryRecordsOptions
): Promise<RetrieveMemoryRecordsResult> {
  const { region, memoryId, namespace, searchQuery, memoryStrategyId, topK, maxResults, nextToken } = options;

  const client = new BedrockAgentCoreClient({
    region,
    credentials: getCredentialProvider(),
  });

  try {
    const response = await client.send(
      new RetrieveMemoryRecordsCommand({
        memoryId,
        namespace,
        searchCriteria: {
          searchQuery,
          memoryStrategyId,
          topK,
        },
        maxResults,
        nextToken,
      })
    );

    const records: MemoryRecordEntry[] = (response.memoryRecordSummaries ?? []).map(r => ({
      memoryRecordId: r.memoryRecordId ?? 'unknown',
      content: r.content?.text,
      memoryStrategyId: r.memoryStrategyId ?? 'unknown',
      namespaces: r.namespaces ?? [],
      createdAt: r.createdAt?.toISOString() ?? 'unknown',
      score: r.score,
      metadata: Object.fromEntries(Object.entries(r.metadata ?? {}).map(([k, v]) => [k, v?.stringValue ?? ''])),
    }));

    return { success: true, records, nextToken: response.nextToken };
  } catch (error: unknown) {
    const err = error as Error;
    if (err.name === 'ResourceNotFoundException') {
      return { success: false, error: `Memory '${memoryId}' not found. It may not have been deployed yet.` };
    }
    return { success: false, error: err.message ?? String(error) };
  }
}
