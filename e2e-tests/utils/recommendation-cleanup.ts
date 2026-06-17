import type { Logger } from './logger';
import {
  type BedrockAgentCoreClient,
  DeleteRecommendationCommand,
  RecommendationStatus,
  type RecommendationSummary,
  paginateListRecommendations,
} from '@aws-sdk/client-bedrock-agentcore';

const ACTIVE_STATUSES: ReadonlySet<RecommendationStatus> = new Set([
  RecommendationStatus.PENDING,
  RecommendationStatus.IN_PROGRESS,
]);

async function deleteRecommendation(
  client: BedrockAgentCoreClient,
  logger: Logger,
  recommendationId: string,
  name: string
): Promise<void> {
  try {
    await client.send(new DeleteRecommendationCommand({ recommendationId }));
    logger.info(`Deleted stale recommendation: ${name} (${recommendationId})`);
  } catch (error) {
    const err = error as Error;
    logger.warn(`Failed to delete recommendation ${name} (${recommendationId}): ${err.name}:${err.message}`);
  }
}

/**
 * Delete e2e recommendations that are still active beyond `minAgeMs` and match `prefix`.
 *
 * The recommendation service caps active recommendations at 5/account. Failed e2e runs
 * can leak ACTIVE recommendations that never reach a terminal state, exhausting the slots
 * and causing every subsequent StartRecommendation call to 402 across all shards.
 *
 * Recommendation has no Stop API — DeleteRecommendation is the cancel.
 */
export async function cleanupStaleRecommendations(
  client: BedrockAgentCoreClient,
  logger: Logger,
  options: {
    minAgeMs: number;
    prefix: string;
  }
): Promise<void> {
  const cutoff = new Date(Date.now() - options.minAgeMs);

  for await (const page of paginateListRecommendations({ client }, {})) {
    const summaries: RecommendationSummary[] = page.recommendationSummaries ?? [];
    const stale = summaries.filter(
      r =>
        r.status !== undefined &&
        ACTIVE_STATUSES.has(r.status) &&
        r.name?.startsWith(options.prefix) &&
        r.createdAt !== undefined &&
        r.createdAt < cutoff
    );

    await Promise.all(stale.map(r => deleteRecommendation(client, logger, r.recommendationId!, r.name!)));
  }
}
