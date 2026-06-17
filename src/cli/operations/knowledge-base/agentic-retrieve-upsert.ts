import type { AgentCoreGatewayTarget, AgentCoreProjectSpec } from '../../../schema';
import { CONNECTOR_ID } from '../../../schema';

/**
 * Ensure exactly one bedrock-agentic-retrieve target exists on this gateway,
 * with kbReference present in its knowledgeBaseIds[]. Idempotent.
 *
 * - Creates the target on first call (named `${gateway.name}-agentic`).
 * - Appends to it on subsequent calls if kbReference is missing.
 * - No-op if kbReference is already in the agentic target's knowledgeBaseIds[].
 *
 * Mutates `gateway.targets` in place. Used by both KnowledgeBasePrimitive
 * (project-owned KBs via `add knowledge-base --gateway`) and
 * GatewayTargetPrimitive (external KBs via `add gateway-target --type
 * connector --connector bedrock-knowledge-bases`) so wiring is consistent
 * across paths.
 *
 * If the user has hand-renamed the agentic target, we respect it and only
 * append; we don't rename it back.
 */
export function upsertAgenticRetrieveTarget(
  gateway: AgentCoreProjectSpec['agentCoreGateways'][number],
  kbReference: string
): void {
  const existing = gateway.targets.find(
    t => t.targetType === 'connector' && t.connectorId === CONNECTOR_ID.BEDROCK_AGENTIC_RETRIEVE
  );
  if (existing) {
    const ids = existing.knowledgeBaseIds ?? [];
    if (!ids.includes(kbReference)) {
      existing.knowledgeBaseIds = [...ids, kbReference];
    }
    return;
  }
  const agenticTarget: AgentCoreGatewayTarget = {
    name: `${gateway.name}-agentic`,
    targetType: 'connector',
    connectorId: CONNECTOR_ID.BEDROCK_AGENTIC_RETRIEVE,
    knowledgeBaseIds: [kbReference],
  } as AgentCoreGatewayTarget;
  gateway.targets.push(agenticTarget);
}
