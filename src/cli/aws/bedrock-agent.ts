import { getCredentialProvider } from './account';
import {
  BedrockAgentClient,
  type DataSource,
  type DataSourceSummary,
  GetDataSourceCommand,
  GetIngestionJobCommand,
  GetKnowledgeBaseCommand,
  type IngestionJob,
  type IngestionJobSummary,
  type KnowledgeBase,
  ListDataSourcesCommand,
  ListIngestionJobsCommand,
  StartIngestionJobCommand,
} from '@aws-sdk/client-bedrock-agent';

/**
 * Region-scoped factory. Each call returns a fresh client; we don't pool because
 * the CLI is a one-shot process and connection reuse provides marginal benefit.
 */
function makeClient(region: string): BedrockAgentClient {
  return new BedrockAgentClient({ region, credentials: getCredentialProvider() });
}

function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: string }).name;
  return name === 'ResourceNotFoundException' || name === 'NotFoundException';
}

export interface KnowledgeBaseLookup {
  region: string;
  knowledgeBaseId: string;
}

/**
 * Fetch a knowledge base by ID. Returns null if the KB doesn't exist; rethrows
 * any other error so the caller can decide how to surface it.
 */
export async function getKnowledgeBase(opts: KnowledgeBaseLookup): Promise<KnowledgeBase | null> {
  const client = makeClient(opts.region);
  try {
    const response = await client.send(new GetKnowledgeBaseCommand({ knowledgeBaseId: opts.knowledgeBaseId }));
    return response.knowledgeBase ?? null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

export interface DataSourceLookup extends KnowledgeBaseLookup {
  dataSourceId: string;
}

export async function getDataSource(opts: DataSourceLookup): Promise<DataSource | null> {
  const client = makeClient(opts.region);
  try {
    const response = await client.send(
      new GetDataSourceCommand({ knowledgeBaseId: opts.knowledgeBaseId, dataSourceId: opts.dataSourceId })
    );
    return response.dataSource ?? null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * List ingestion jobs for a (KB, DS) pair. Returns an empty array if the
 * (KB, DS) pair doesn't exist or has no jobs.
 *
 * Paginates through every page (loops until `nextToken` is undefined) so the
 * caller sees the full job history; the service caps a single page at 100
 * summaries by default, and a busy KB can have far more than that.
 *
 * Accepts an optional pre-built client so callers (e.g. {@link getLatestIngestionJob})
 * can avoid re-resolving credentials and re-establishing the TCP session for
 * follow-up calls in the same chain.
 */
export async function listIngestionJobs(
  opts: DataSourceLookup,
  client: BedrockAgentClient = makeClient(opts.region)
): Promise<IngestionJobSummary[]> {
  const summaries: IngestionJobSummary[] = [];
  let nextToken: string | undefined;
  try {
    do {
      const response = await client.send(
        new ListIngestionJobsCommand({
          knowledgeBaseId: opts.knowledgeBaseId,
          dataSourceId: opts.dataSourceId,
          nextToken,
        })
      );
      if (response.ingestionJobSummaries) {
        summaries.push(...response.ingestionJobSummaries);
      }
      nextToken = response.nextToken;
    } while (nextToken);
    return summaries;
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

/**
 * List the data sources attached to a knowledge base. Used post-deploy to
 * resolve data-source IDs once CFN has settled (the L3 emits per-KB outputs
 * but not per-DS outputs, so we look them up by listing the KB's children).
 *
 * Bedrock paginates this API; this function exhausts every page so callers
 * never see a partial DS list.
 *
 * Returns an empty array if the KB doesn't exist or has no DSes.
 */
export async function listDataSources(opts: KnowledgeBaseLookup): Promise<DataSourceSummary[]> {
  const client = makeClient(opts.region);
  const summaries: DataSourceSummary[] = [];
  let nextToken: string | undefined;
  try {
    do {
      const response = await client.send(
        new ListDataSourcesCommand({ knowledgeBaseId: opts.knowledgeBaseId, nextToken })
      );
      if (response.dataSourceSummaries) {
        summaries.push(...response.dataSourceSummaries);
      }
      nextToken = response.nextToken;
    } while (nextToken);
    return summaries;
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

/**
 * Start a fresh ingestion job for a (KB, DS) pair. Surfaces all service errors
 * verbatim — the caller decides how to format user-facing messages (e.g. via
 * IngestionError).
 */
export async function startIngestionJob(opts: DataSourceLookup): Promise<IngestionJob> {
  const client = makeClient(opts.region);
  const response = await client.send(
    new StartIngestionJobCommand({ knowledgeBaseId: opts.knowledgeBaseId, dataSourceId: opts.dataSourceId })
  );
  if (!response.ingestionJob) {
    throw new Error('StartIngestionJob succeeded but returned no ingestion job in the response');
  }
  return response.ingestionJob;
}

/**
 * List ingestion jobs and fetch the most recently started one's full details.
 * Returns null if no jobs have ever run for this DS.
 *
 * Reuses a single BedrockAgentClient across the list + get calls so we don't
 * resolve credentials twice for one logical lookup.
 */
export async function getLatestIngestionJob(opts: DataSourceLookup): Promise<IngestionJob | null> {
  const client = makeClient(opts.region);
  const summaries = await listIngestionJobs(opts, client);
  if (summaries.length === 0) return null;

  const latest = summaries.reduce((best, current) => {
    const bestStarted = best.startedAt?.getTime() ?? 0;
    const currentStarted = current.startedAt?.getTime() ?? 0;
    return currentStarted > bestStarted ? current : best;
  });

  if (!latest.ingestionJobId) return null;

  const response = await client.send(
    new GetIngestionJobCommand({
      knowledgeBaseId: opts.knowledgeBaseId,
      dataSourceId: opts.dataSourceId,
      ingestionJobId: latest.ingestionJobId,
    })
  );
  return response.ingestionJob ?? null;
}
