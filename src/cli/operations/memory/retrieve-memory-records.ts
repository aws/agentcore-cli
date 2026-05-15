import { ResourceNotFoundError, ValidationError, toError } from '../../../lib';
import type { Result } from '../../../lib/result';
import { getCredentialProvider } from '../../aws';
import type { MemoryRecordEntry } from './list-memory-records';
import { BedrockAgentCoreClient, RetrieveMemoryRecordsCommand } from '@aws-sdk/client-bedrock-agentcore';

/**
 * Base options for retrieving memory records, excluding the namespace filter.
 * @internal
 */
interface RetrieveMemoryRecordsOptionsBase {
  region: string;
  memoryId: string;
  searchQuery: string;
  memoryStrategyId?: string;
  topK?: number;
  maxResults?: number;
  nextToken?: string;
}

/**
 * Options for retrieving memory records. Exactly one of `namespace` (exact match) or
 * `namespacePath` (hierarchical path prefix) must be provided.
 */
export type RetrieveMemoryRecordsOptions =
  | (RetrieveMemoryRecordsOptionsBase & { namespace: string; namespacePath?: never })
  | (RetrieveMemoryRecordsOptionsBase & { namespace?: never; namespacePath: string });

export type RetrieveMemoryRecordsResult = Result<{ records: MemoryRecordEntry[]; nextToken?: string }>;

/**
 * Searches memory records using semantic retrieval via the AWS SDK.
 *
 * Exactly one of `namespace` (exact match) or `namespacePath` (hierarchical path prefix)
 * must be provided.
 */
export async function retrieveMemoryRecords(
  options: RetrieveMemoryRecordsOptions
): Promise<RetrieveMemoryRecordsResult> {
  const { region, memoryId, namespace, namespacePath, searchQuery, memoryStrategyId, topK, maxResults, nextToken } =
    options;

  // Defensive runtime check — the discriminated union enforces this at compile time, but we
  // also validate at runtime to protect against callers bypassing the type system. Treats
  // empty-string as "not provided"
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
      new RetrieveMemoryRecordsCommand({
        memoryId,
        ...(namespace ? { namespace } : { namespacePath }),
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
      return {
        success: false,
        error: new ResourceNotFoundError(`Memory '${memoryId}' not found. It may not have been deployed yet.`),
      };
    }
    return { success: false, error: toError(error) };
  }
}
