import { ResourceNotFoundError, ValidationError, toError } from '../../../lib';
import type { Result } from '../../../lib/result';
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

/**
 * Base options for listing memory records, excluding the namespace filter.
 * @internal
 */
interface ListMemoryRecordsOptionsBase {
  region: string;
  memoryId: string;
  memoryStrategyId?: string;
  maxResults?: number;
  nextToken?: string;
}

/**
 * Options for listing memory records. Exactly one of `namespace` (exact match) or
 * `namespacePath` (hierarchical path prefix) must be provided.
 */
export type ListMemoryRecordsOptions =
  | (ListMemoryRecordsOptionsBase & { namespace: string; namespacePath?: never })
  | (ListMemoryRecordsOptionsBase & { namespace?: never; namespacePath: string });

export type ListMemoryRecordsResult = Result<{ records: MemoryRecordEntry[]; nextToken?: string }>;

/**
 * Lists memory records for a deployed memory resource via the AWS SDK.
 *
 * Exactly one of `namespace` (exact match) or `namespacePath` (hierarchical path prefix)
 * must be provided.
 */
export async function listMemoryRecords(options: ListMemoryRecordsOptions): Promise<ListMemoryRecordsResult> {
  const { region, memoryId, namespace, namespacePath, memoryStrategyId, maxResults = 50, nextToken } = options;

  // Defensive runtime check — the discriminated union enforces this at compile time, but we
  // also validate at runtime to protect against callers bypassing the type system (e.g. JSON
  // input from web UI handlers). Treats empty-string as "not provided"
  if (namespace && namespacePath) {
    return { success: false, error: new ValidationError("'namespace' and 'namespacePath' are mutually exclusive.") };
  }
  if (!namespace && !namespacePath) {
    return { success: false, error: new ValidationError("Either 'namespace' or 'namespacePath' must be provided.") };
  }

  const client = new BedrockAgentCoreClient({
    region,
    credentials: getCredentialProvider(),
  });

  try {
    const response = await client.send(
      new ListMemoryRecordsCommand({
        memoryId,
        ...(namespace ? { namespace } : { namespacePath }),
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
      return {
        success: false,
        error: new ResourceNotFoundError(`Memory '${memoryId}' not found. It may not have been deployed yet.`),
      };
    }
    return { success: false, error: toError(error) };
  }
}
