import { ConfigIO } from '../../../lib';
import type { Memory, MemoryStrategy, MemoryStrategyType } from '../../../schema';
import { DEFAULT_STRATEGY_NAMESPACES } from '../../../schema';

/**
 * Config for creating a memory resource.
 */
export interface CreateMemoryConfig {
  name: string;
  eventExpiryDuration: number;
  strategies: { type: string }[];
}

/**
 * Get list of existing memory names from the project.
 */
export async function getAllMemoryNames(): Promise<string[]> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();
    return project.memories.map(m => m.name);
  } catch {
    return [];
  }
}

/**
 * Create a memory resource and add it to the project.
 */
export async function createMemory(config: CreateMemoryConfig): Promise<Memory> {
  const configIO = new ConfigIO();
  const project = await configIO.readProjectSpec();

  // Check for duplicate
  if (project.memories.some(m => m.name === config.name)) {
    throw new Error(`Memory "${config.name}" already exists.`);
  }

  // Map strategies with their default namespaces
  const strategies: MemoryStrategy[] = config.strategies.map(s => {
    const strategyType = s.type as MemoryStrategyType;
    const defaultNamespaces = DEFAULT_STRATEGY_NAMESPACES[strategyType];
    return {
      type: strategyType,
      ...(defaultNamespaces && { namespaces: defaultNamespaces }),
    };
  });

  const memory: Memory = {
    type: 'AgentCoreMemory',
    name: config.name,
    eventExpiryDuration: config.eventExpiryDuration,
    strategies,
  };

  project.memories.push(memory);
  await configIO.writeProjectSpec(project);

  return memory;
}
