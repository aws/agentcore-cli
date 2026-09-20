import { MemoryManager } from '@strands-agents/sdk';
import { createAgentCoreMemoryStores } from 'bedrock-agentcore/experimental/memory/strands';

const MEMORY_ID = process.env.{{memoryEnvVarName}};

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
      { namespace: '/users/{actorId}/facts' },
      { namespace: '/users/{actorId}/preferences' },
      { namespace: '/episodes/{actorId}/{sessionId}' },
      { namespace: '/summaries/{actorId}' },
    ],
    // readMode defaults to 'per-namespace' (one retrieve call per namespace).
    // Switch to 'subtree' to consolidate to a single hierarchical recall call.
    extraction: true,
  });

  manager = new MemoryManager({ stores });
  memoryManagerCache.set(key, manager);
  return manager;
}
