import { getCredentialProvider } from '../../aws';
import { BedrockAgentCoreClient, ListMemoryRecordsCommand } from '@aws-sdk/client-bedrock-agentcore';

export interface MemoryRecordEntry {
  memoryRecordId: string;
  content: string | undefined;
  memoryStrategyId: string;
  namespaces: string[];
  createdAt: string;
  score: number | undefined;
  metadata: Record<string, string>;
}

export interface ListMemoryRecordsOptions {
  region: string;
  memoryId: string;
  namespace: string;
  memoryStrategyId?: string;
  maxResults?: number;
  nextToken?: string;
}

export interface ListMemoryRecordsResult {
  success: boolean;
  records?: MemoryRecordEntry[];
  nextToken?: string;
  error?: string;
}

/**
 * Lists memory records for a deployed memory resource via the AWS SDK.
 */
export async function listMemoryRecords(options: ListMemoryRecordsOptions): Promise<ListMemoryRecordsResult> {
  const { region, memoryId, namespace, memoryStrategyId, maxResults = 50, nextToken } = options;

  const client = new BedrockAgentCoreClient({
    region,
    credentials: getCredentialProvider(),
  });

  try {
    const response = await client.send(
      new ListMemoryRecordsCommand({
        memoryId,
        namespace,
        memoryStrategyId,
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
