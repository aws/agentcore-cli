import { randomUUID } from 'node:crypto';
import { MemoryManager } from '@strands-agents/sdk';
import { createAgentCoreMemoryStores } from 'bedrock-agentcore/experimental/memory/strands';

const MEMORY_ID = process.env.{{memoryEnvVarName}};

const CUSTOM_ACTOR_ID_HEADER = 'x-amzn-bedrock-agentcore-runtime-custom-actor-id';

export function getActorId(payload: any, context: any): string {
  const raw =
    context?.headers?.[CUSTOM_ACTOR_ID_HEADER] ||
    payload?.userId ||
    context?.sessionId;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : randomUUID();
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
{{#if (includes memoryStrategies "SEMANTIC")}}
      { namespace: '/users/{actorId}/facts' },
{{/if}}
{{#if (includes memoryStrategies "USER_PREFERENCE")}}
      { namespace: '/users/{actorId}/preferences' },
{{/if}}
{{#if (includes memoryStrategies "EPISODIC")}}
      { namespace: '/episodes/{actorId}/{sessionId}' },
{{/if}}
{{#if (includes memoryStrategies "SUMMARIZATION")}}
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
