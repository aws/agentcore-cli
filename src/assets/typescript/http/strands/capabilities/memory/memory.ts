import { randomUUID } from 'node:crypto';
import { MemoryManager } from '@strands-agents/sdk';
import { createAgentCoreMemoryStores } from 'bedrock-agentcore/experimental/memory/strands';

const MEMORY_ID = process.env.{{memoryProviders.[0].envVarName}};

const CUSTOM_ACTOR_ID_HEADER = 'x-amzn-bedrock-agentcore-runtime-custom-actor-id';

export function getActorId(payload: any, context: any): string {
  // Multi-actor agents: caller passes user via the custom header (declared in
  // requestHeaderAllowlist) or as a `userId` field in the invocation payload.
  // Single-actor agents: actorId == sessionId is fine.
  // RandomUUID fallback when all sources are absent
  return (
    context?.headers?.[CUSTOM_ACTOR_ID_HEADER] ??
    payload?.userId ??
    context?.sessionId ??
    randomUUID()
  );
}

const memoryManagerCache = new Map<string, MemoryManager>();

export function getOrCreateMemoryManager(sessionId: string, actorId: string): MemoryManager | null {
  if (!MEMORY_ID) return null;

  const key = `${actorId}:${sessionId}`;
  let manager = memoryManagerCache.get(key);
  if (manager) return manager;

  const stores = createAgentCoreMemoryStores({
    memoryId: MEMORY_ID,
    actorId,
    sessionId,
    namespaces: [
{{#if (includes memoryProviders.[0].strategies "SEMANTIC")}}
      { namespace: '/users/{actorId}/facts' },
{{/if}}
{{#if (includes memoryProviders.[0].strategies "USER_PREFERENCE")}}
      { namespace: '/users/{actorId}/preferences' },
{{/if}}
{{#if (includes memoryProviders.[0].strategies "EPISODIC")}}
      { namespace: '/episodes/{actorId}/{sessionId}' },
{{/if}}
{{#if (includes memoryProviders.[0].strategies "SUMMARIZATION")}}
      { namespace: '/summaries/{actorId}/{sessionId}' },
{{/if}}
    ],
    // readMode defaults to 'per-namespace' (one retrieve call per namespace).
    // Switch to 'subtree' to consolidate to a single hierarchical recall call.
    extraction: true,
  });

  manager = new MemoryManager({ stores });
  memoryManagerCache.set(key, manager);
  return manager;
}
