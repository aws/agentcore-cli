import type { KnowledgeBase, KnowledgeBaseDeployedState } from '../../../schema';
import { listDataSources } from '../../aws/bedrock-agent';
import { createHash } from 'node:crypto';

export interface HydrateInput {
  /** KB deployed-state records as parsed from CFN outputs (id + arn populated, dataSources empty). */
  knowledgeBases: Record<string, KnowledgeBaseDeployedState>;
  /** Local KB specs from agentcore.json — used to recover URIs for the deployed DS IDs. */
  knowledgeBaseSpecs: KnowledgeBase[];
  /** AWS region (passed through to bedrock-agent SDK calls). */
  region: string;
}

/**
 * The L3's `AgentCoreKnowledgeBase` names each DataSource as
 *   `${knowledgeBasePhysicalName}_ds_${uriHashPrefix}`
 * where `uriHashPrefix` is the first 8 hex chars of SHA-256(uri). This must
 * stay byte-equivalent to the L3's
 *   createHash('sha256').update(ds.uri).digest('hex').slice(0, 8)
 * or the hash-based fallback below loses every DS.
 */
function uriHashPrefix(uri: string): string {
  return createHash('sha256').update(uri).digest('hex').slice(0, 8);
}

/**
 * Hydrate the `dataSources[]` array on each KB deployed-state record.
 *
 * Preferred path: `parseKnowledgeBaseOutputs` already populates
 * `dataSources[]` from per-DS CFN outputs (L3 #234 onward). This function is
 * a no-op for KBs whose outputs were present.
 *
 * Fallback path: when CFN outputs are absent (stack was deployed against an
 * older L3, or a partial deploy), call bedrock-agent:ListDataSources and
 * pair each deployed DS with its local spec by URI-hash suffix. The L3 names
 * each DS deterministically using the first 8 chars of SHA-256(uri); we
 * compute the same hash for every local URI and look it up against the
 * deployed DS names. This is robust to ListDataSources ordering changes and
 * to data sources being added or removed between deploys.
 *
 * Leaves `dataSources` as an empty array if both paths fail — the caller
 * decides how to surface partial hydration.
 */
export async function hydrateKnowledgeBaseDataSources(input: HydrateInput): Promise<void> {
  const specsByName = new Map(input.knowledgeBaseSpecs.map(s => [s.name, s]));

  for (const [name, deployed] of Object.entries(input.knowledgeBases)) {
    if (deployed.dataSources.length > 0) continue;

    const spec = specsByName.get(name);
    if (!spec) continue;

    const summaries = await listDataSources({
      region: input.region,
      knowledgeBaseId: deployed.knowledgeBaseId,
    });

    // Build a hash-suffix → DS-id index from the deployed DSes so we can look
    // up by URI hash without depending on ListDataSources ordering.
    const idByHash = new Map<string, string>();
    for (const summary of summaries) {
      if (!summary.dataSourceId || !summary.name) continue;
      const match = /_ds_([0-9a-f]+)$/.exec(summary.name);
      if (!match) continue;
      idByHash.set(match[1]!, summary.dataSourceId);
    }

    // For each local DS spec, recover the deployed DS id by URI hash.
    const hydrated: { dataSourceId: string; uri: string }[] = [];
    for (const localDs of spec.dataSources) {
      if (localDs.type !== 'S3') continue;
      const dataSourceId = idByHash.get(uriHashPrefix(localDs.uri));
      if (!dataSourceId) continue;
      hydrated.push({ dataSourceId, uri: localDs.uri });
    }

    deployed.dataSources = hydrated;
  }
}
