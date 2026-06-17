import type { DeployedState, KnowledgeBase, KnowledgeBaseDeployedState } from '../../../schema';
import { runKbIngestionByName } from '../ingest';
import { createHash } from 'node:crypto';

export interface AutoIngestKnowledgeBasesOptions {
  region: string;
  knowledgeBases: KnowledgeBase[];
  /** Current deployed-state record (KB id/arn populated, dataSources hydrated, sourcesHash possibly stale). */
  deployedKnowledgeBases: Record<string, KnowledgeBaseDeployedState>;
  /** Prior deployed-state record for sourcesHash comparison. */
  previousKnowledgeBases?: Record<string, KnowledgeBaseDeployedState>;
  /** Deployment target name (passed through to runKbIngestionByName). */
  targetName: string;
  /** Full deployed-state (passed through to runKbIngestionByName). */
  deployedState: DeployedState;
  /**
   * Optional progress callback. When the retry loop sleeps because Bedrock
   * is busy with a sibling job, this is called with a short status line so
   * the deploy logger can echo it (otherwise the deploy looks frozen).
   */
  onProgress?: (message: string) => void;
  /** Optional abort signal forwarded to the retry sleep. */
  signal?: AbortSignal;
}

export interface AutoIngestEntry {
  knowledgeBaseName: string;
  status: 'started' | 'skipped' | 'error';
  /** Number of data sources for which an ingestion job was started. */
  startedJobCount?: number;
  /** Reason for skipping (e.g. 'no changes to data sources'). */
  reason?: string;
  /** Error message when status is 'error'. */
  error?: string;
  /** New sourcesHash to persist when status is 'started'. */
  newSourcesHash?: string;
}

export interface AutoIngestKnowledgeBasesResult {
  hasErrors: boolean;
  results: AutoIngestEntry[];
}

/**
 * Compute the SHA-256 over the data-source URIs of a KB spec, joined with
 * newlines. The post-deploy hook compares this to the previously-stored
 * sourcesHash to decide whether to re-trigger ingestion.
 */
export function computeSourcesHash(kb: KnowledgeBase): string {
  return createHash('sha256')
    .update(kb.dataSources.map(ds => (ds.type === 'S3' ? ds.uri : ds.connectorConfigFile)).join('\n'))
    .digest('hex');
}

/**
 * For each KB in the project, fire StartIngestionJob if the current
 * sourcesHash differs from the one stored in the prior deployed-state.
 *
 * Skipped KBs (no change) are reported in `results` with status 'skipped'.
 * Errors are reported with status 'error' and surfaced in `hasErrors`; they
 * do NOT abort the post-deploy flow because ingestion is async and retryable
 * via `agentcore run ingest`.
 *
 * Caller is responsible for persisting `newSourcesHash` onto the deployed
 * state record after this returns.
 */
export async function autoIngestKnowledgeBases(
  opts: AutoIngestKnowledgeBasesOptions
): Promise<AutoIngestKnowledgeBasesResult> {
  const results: AutoIngestEntry[] = [];

  for (const kb of opts.knowledgeBases) {
    const deployed = opts.deployedKnowledgeBases[kb.name];
    if (!deployed) {
      // KB wasn't deployed (CFN output missing) — nothing to ingest into yet.
      results.push({
        knowledgeBaseName: kb.name,
        status: 'skipped',
        reason: 'KB not present in deployed state (CFN outputs missing)',
      });
      continue;
    }
    if (deployed.dataSources.length === 0) {
      results.push({
        knowledgeBaseName: kb.name,
        status: 'skipped',
        reason: 'no data sources recorded',
      });
      continue;
    }

    const newHash = computeSourcesHash(kb);
    const previousHash = opts.previousKnowledgeBases?.[kb.name]?.sourcesHash;

    if (previousHash && previousHash === newHash) {
      results.push({
        knowledgeBaseName: kb.name,
        status: 'skipped',
        reason: 'no changes to data sources',
      });
      continue;
    }

    const ingestResult = await runKbIngestionByName({
      knowledgeBaseName: kb.name,
      deployedState: opts.deployedState,
      targetName: opts.targetName,
      region: opts.region,
      onProgress: opts.onProgress,
      signal: opts.signal,
    });

    if (!ingestResult.success) {
      results.push({
        knowledgeBaseName: kb.name,
        status: 'error',
        error: ingestResult.error.message,
      });
      continue;
    }

    results.push({
      knowledgeBaseName: kb.name,
      status: 'started',
      startedJobCount: ingestResult.startedJobs.length,
      newSourcesHash: newHash,
    });
  }

  return {
    hasErrors: results.some(r => r.status === 'error'),
    results,
  };
}
