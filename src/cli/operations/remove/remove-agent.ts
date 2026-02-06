import { ConfigIO } from '../../../lib';
import type { RemovalPreview, RemovalResult, SchemaChange } from './types';

/**
 * Get list of agents available for removal.
 */
export async function getRemovableAgents(): Promise<string[]> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();
    return project.agents.map(a => a.name);
  } catch {
    return [];
  }
}

/**
 * Preview what will be removed when removing an agent.
 */
export async function previewRemoveAgent(agentName: string): Promise<RemovalPreview> {
  const configIO = new ConfigIO();
  const project = await configIO.readProjectSpec();

  const agent = project.agents.find(a => a.name === agentName);
  if (!agent) {
    throw new Error(`Agent "${agentName}" not found.`);
  }

  const summary: string[] = [`Removing agent: ${agentName}`];
  const schemaChanges: SchemaChange[] = [];

  const afterSpec = {
    ...project,
    agents: project.agents.filter(a => a.name !== agentName),
  };

  schemaChanges.push({
    file: 'agentcore/agentcore.json',
    before: project,
    after: afterSpec,
  });

  return { summary, directoriesToDelete: [], schemaChanges };
}

/**
 * Remove an agent from the project.
 */
export async function removeAgent(agentName: string): Promise<RemovalResult> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();

    const agentIndex = project.agents.findIndex(a => a.name === agentName);
    if (agentIndex === -1) {
      return { ok: false, error: `Agent "${agentName}" not found.` };
    }

    project.agents.splice(agentIndex, 1);
    await configIO.writeProjectSpec(project);

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: message };
  }
}
