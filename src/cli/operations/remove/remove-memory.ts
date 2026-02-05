import { ConfigIO } from '../../../lib';
import type { RemovalPreview, RemovalResult, SchemaChange } from './types';

/**
 * Represents a memory that can be removed.
 */
export interface RemovableMemory {
  name: string;
}

/**
 * Get list of memories available for removal.
 */
export async function getRemovableMemories(): Promise<RemovableMemory[]> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();
    return project.memories.map(m => ({ name: m.name }));
  } catch {
    return [];
  }
}

/**
 * Preview what will be removed when removing a memory.
 */
export async function previewRemoveMemory(memoryName: string): Promise<RemovalPreview> {
  const configIO = new ConfigIO();
  const project = await configIO.readProjectSpec();

  const memory = project.memories.find(m => m.name === memoryName);
  if (!memory) {
    throw new Error(`Memory "${memoryName}" not found.`);
  }

  const summary: string[] = [`Removing memory: ${memoryName}`];
  const schemaChanges: SchemaChange[] = [];

  const afterSpec = {
    ...project,
    memories: project.memories.filter(m => m.name !== memoryName),
  };

  schemaChanges.push({
    file: 'agentcore/agentcore.json',
    before: project,
    after: afterSpec,
  });

  return { summary, directoriesToDelete: [], schemaChanges };
}

/**
 * Remove a memory from the project.
 */
export async function removeMemory(memoryName: string): Promise<RemovalResult> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();

    const memoryIndex = project.memories.findIndex(m => m.name === memoryName);
    if (memoryIndex === -1) {
      return { ok: false, error: `Memory "${memoryName}" not found.` };
    }

    project.memories.splice(memoryIndex, 1);
    await configIO.writeProjectSpec(project);

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: message };
  }
}
