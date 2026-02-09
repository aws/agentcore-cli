import { ConfigIO } from '../../../lib';
import type { Credential } from '../../../schema';
import type { RemovalPreview, RemovalResult, SchemaChange } from './types';

// Providers that use credentials (Bedrock uses IAM, no credential)
export const CREDENTIAL_PROVIDERS = ['Gemini', 'OpenAI', 'Anthropic'] as const;

/**
 * Find agent-scoped credentials for a given agent.
 * Pattern: {projectName}{agentName}{provider}
 */
export function getAgentScopedCredentials(
  projectName: string,
  agentName: string,
  credentials: Credential[]
): Credential[] {
  const prefix = `${projectName}${agentName}`;
  return credentials.filter(c => {
    if (!c.name.startsWith(prefix)) return false;
    const suffix = c.name.slice(prefix.length);
    return CREDENTIAL_PROVIDERS.includes(suffix as (typeof CREDENTIAL_PROVIDERS)[number]);
  });
}

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

  // Identify agent-scoped credentials
  const agentCredentials = getAgentScopedCredentials(project.name, agentName, project.credentials);
  if (agentCredentials.length > 0) {
    summary.push(`Will remove ${agentCredentials.length} agent-scoped credential(s):`);
    agentCredentials.forEach(c => summary.push(`  - ${c.name}`));
  }

  const afterSpec = {
    ...project,
    agents: project.agents.filter(a => a.name !== agentName),
    credentials: project.credentials.filter(c => !agentCredentials.some(ac => ac.name === c.name)),
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

    // Remove agent
    project.agents.splice(agentIndex, 1);

    // Remove agent-scoped credentials
    const agentCredentials = getAgentScopedCredentials(project.name, agentName, project.credentials);
    project.credentials = project.credentials.filter(c => !agentCredentials.some(ac => ac.name === c.name));

    await configIO.writeProjectSpec(project);

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: message };
  }
}
