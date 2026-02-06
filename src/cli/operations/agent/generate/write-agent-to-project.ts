import { ConfigIO, requireConfigRoot } from '../../../../lib';
import type { AgentCoreProjectSpec } from '../../../../schema';
import { SCHEMA_VERSION } from '../../../constants';
import { AgentAlreadyExistsError } from '../../../errors';
import type { GenerateConfig } from '../../../tui/screens/generate/types';
import { mapGenerateConfigToAgent, mapGenerateInputToMemories, mapModelProviderToCredentials } from './schema-mapper';

export interface WriteAgentOptions {
  configBaseDir?: string;
}

/**
 * Writes a new agent (and associated resources) to the agentcore.json project config.
 *
 * In v2 schema:
 * - Agent goes to project.agents[]
 * - Memory resources go to project.memories[]
 * - Credential resources go to project.credentials[]
 */
export async function writeAgentToProject(config: GenerateConfig, options?: WriteAgentOptions): Promise<void> {
  const configBaseDir = options?.configBaseDir ?? requireConfigRoot();
  const configIO = new ConfigIO({ baseDir: configBaseDir });

  // Map agent config to resources
  // Note: config.projectName is actually the agent name (GenerateConfig naming is confusing)
  const agentName = config.projectName;
  const agent = mapGenerateConfigToAgent(config);
  const memories = mapGenerateInputToMemories(config.memory, agentName);

  if (configIO.configExists('project')) {
    const project = await configIO.readProjectSpec();

    // Check for duplicate agent name
    if (project.agents.some(a => a.name === agentName)) {
      throw new AgentAlreadyExistsError(agentName);
    }

    // Use actual project name for credential naming (not agent name)
    const credentials = mapModelProviderToCredentials(config.modelProvider, project.name);

    // Add resources to project
    project.agents.push(agent);
    project.memories.push(...memories);
    project.credentials.push(...credentials);

    await configIO.writeProjectSpec(project);
  } else {
    // Create new project - use agent name as project name (fallback for standalone generate)
    const credentials = mapModelProviderToCredentials(config.modelProvider, agentName);
    const project: AgentCoreProjectSpec = {
      name: agentName,
      version: SCHEMA_VERSION,
      agents: [agent],
      memories,
      credentials,
    };

    await configIO.writeProjectSpec(project);
  }
}
