import { IngestionError } from '../../../lib';
import type { Result } from '../../../lib/result';
import type { DeployedState } from '../../../schema';
import { startIngestionJob } from '../../aws/bedrock-agent';

export interface RunKbIngestionInput {
  knowledgeBaseName: string;
  deployedState: DeployedState;
  targetName: string;
  region: string;
  /**
   * When set, ingest only the data source whose recorded URI matches this
   * value, instead of every data source on the KB. Returns a user error if no
   * data source has this URI.
   */
  dataSourceUri?: string;
  /**
   * Override the concurrent-limit retry policy. Defaults to {@link DEFAULT_CONCURRENT_RETRY_POLICY}.
   * Tests pass a tight policy to keep runs fast.
   */
  concurrentRetryPolicy?: ConcurrentRetryPolicy;
  /**
   * Optional callback for progress updates during the retry loop. Called when
   * an attempt is rejected with a concurrent-limit error and we sleep before
   * the next attempt. Surfaced to the user via deploy logger / stdout so a
   * quiet 5-minute wait isn't mistaken for a hang.
   */
  onProgress?: (message: string) => void;
  /**
   * Optional abort signal. When triggered, cancels any pending sleep between
   * retries and returns failure for the in-flight DS. Already-started jobs
   * are not rolled back.
   */
  signal?: AbortSignal;
}

export interface ConcurrentRetryPolicy {
  /** Max attempts per data source (1 = no retry). */
  maxAttempts: number;
  /** Delay before each retry, in milliseconds. */
  delayMs: number;
}

/**
 * Bedrock allows only one in-flight ingestion job per knowledge base. When we
 * fire StartIngestionJob for multi-DS KBs the second+ call usually races and
 * gets rejected with ConflictException. Retry up to 4 times (~5min total at
 * 75s intervals) which comfortably covers the average ingestion-job duration
 * for small S3 sources.
 */
export const DEFAULT_CONCURRENT_RETRY_POLICY: ConcurrentRetryPolicy = {
  maxAttempts: 5,
  delayMs: 75_000,
};

function isConcurrentLimitError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string };
  if (e.name === 'ConflictException') return true;
  return typeof e.message === 'string' && /concurrent ingestion jobs/i.test(e.message);
}

/**
 * Sleep that resolves early if the abort signal fires. Resolves cleanly in
 * either case so the caller can decide whether to honour the abort by checking
 * `signal.aborted` afterwards.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface StartedIngestion {
  dataSourceId: string;
  uri: string;
  ingestionJobId: string;
}

export type RunKbIngestionResult = Result<{ startedJobs: StartedIngestion[] }, IngestionError>;

/**
 * Start ingestion for every data source on a deployed KB, returning the new
 * ingestion-job IDs.
 *
 * Used by:
 * - `agentcore run ingest --name X` for manual retry
 * - The post-deploy auto-ingestion hook (when sourcesHash changed since last
 *   deploy)
 *
 * Pre-conditions:
 * - The KB has been deployed (the deployed-state has a record for it).
 * - At least one data source has been recorded in the deployed-state.
 *
 * Failure model:
 * - Pre-flight failures (KB not deployed, no DSes) return success: false with
 *   errorSource overridden to 'user'.
 * - Service failures bubble up the bedrock-agent error message; if any DS
 *   start fails, the function returns success: false and lists the failed
 *   DS(es) by ID. Successful starts are NOT rolled back.
 */
export async function runKbIngestionByName(input: RunKbIngestionInput): Promise<RunKbIngestionResult> {
  const { knowledgeBaseName, deployedState, targetName, region, onProgress, signal } = input;
  const retryPolicy = input.concurrentRetryPolicy ?? DEFAULT_CONCURRENT_RETRY_POLICY;

  const target = deployedState.targets[targetName];
  const deployed = target?.resources?.knowledgeBases?.[knowledgeBaseName];
  if (!deployed) {
    return {
      success: false,
      error: new IngestionError(
        `Knowledge base '${knowledgeBaseName}' has not been deployed to target '${targetName}'. Run 'agentcore deploy' first.`,
        { errorSource: 'user' }
      ),
    };
  }

  if (deployed.dataSources.length === 0) {
    return {
      success: false,
      error: new IngestionError(`Knowledge base '${knowledgeBaseName}' has no data sources to ingest.`, {
        errorSource: 'user',
      }),
    };
  }

  let toIngest = deployed.dataSources;
  if (input.dataSourceUri) {
    toIngest = deployed.dataSources.filter(ds => ds.uri === input.dataSourceUri);
    if (toIngest.length === 0) {
      return {
        success: false,
        error: new IngestionError(
          `Data source '${input.dataSourceUri}' not found on knowledge base '${knowledgeBaseName}'.`,
          { errorSource: 'user' }
        ),
      };
    }
  }

  const startedJobs: StartedIngestion[] = [];
  const failures: { dataSourceId: string; uri: string; error: unknown }[] = [];
  // Sequential to play nice with Bedrock's 1-concurrent-job-per-KB cap. When
  // a start fails because a sibling job is still running, sleep and retry.
  for (const ds of toIngest) {
    if (signal?.aborted) {
      failures.push({
        dataSourceId: ds.dataSourceId,
        uri: ds.uri,
        error: new Error('Aborted before start'),
      });
      continue;
    }
    let lastError: unknown;
    let started = false;
    for (let attempt = 1; attempt <= retryPolicy.maxAttempts; attempt++) {
      try {
        const job = await startIngestionJob({
          region,
          knowledgeBaseId: deployed.knowledgeBaseId,
          dataSourceId: ds.dataSourceId,
        });
        if (!job.ingestionJobId) {
          lastError = new Error('No ingestionJobId in StartIngestionJob response');
          break;
        }
        startedJobs.push({
          dataSourceId: ds.dataSourceId,
          uri: ds.uri,
          ingestionJobId: job.ingestionJobId,
        });
        started = true;
        break;
      } catch (err) {
        lastError = err;
        if (!isConcurrentLimitError(err) || attempt === retryPolicy.maxAttempts) break;
        const delaySeconds = Math.round(retryPolicy.delayMs / 1000);
        onProgress?.(
          `${ds.dataSourceId} (${ds.uri}): another ingestion job is running on this KB, retry ${attempt}/${retryPolicy.maxAttempts - 1} in ${delaySeconds}s…`
        );
        await sleep(retryPolicy.delayMs, signal);
        if (signal?.aborted) {
          lastError = new Error('Aborted while waiting for concurrent ingestion job to drain');
          break;
        }
      }
    }
    if (!started) {
      failures.push({ dataSourceId: ds.dataSourceId, uri: ds.uri, error: lastError });
    }
  }

  if (failures.length > 0) {
    const detail = failures
      .map(f => `  ${f.dataSourceId} (${f.uri}): ${f.error instanceof Error ? f.error.message : String(f.error)}`)
      .join('\n');
    return {
      success: false,
      error: new IngestionError(
        `Failed to start ingestion for ${failures.length} of ${toIngest.length} data sources:\n${detail}`
      ),
    };
  }

  return { success: true, startedJobs };
}
