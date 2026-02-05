import { ConfigIO, requireConfigRoot } from '../../../../lib';
import type { AgentCoreProjectSpec } from '../../../../schema';
import { SCHEMA_VERSION } from '../../../constants';
import { AgentAlreadyExistsError } from '../../../errors';
import type { GenerateConfig } from '../../../tui/screens/generate/types';
import { mapGenerateConfigToResources } from './schema-mapper';

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
  const { agent, memories, credentials } = mapGenerateConfigToResources(config);

  if (configIO.configExists('project')) {
    const project = await configIO.readProjectSpec();

    // Check for duplicate agent name
    if (project.agents.some(a => a.name === config.projectName)) {
      throw new AgentAlreadyExistsError(config.projectName);
    }

    // Add resources to project
    project.agents.push(agent);
    project.memories.push(...memories);
    project.credentials.push(...credentials);

    await configIO.writeProjectSpec(project);
  } else {
    // Create new project
    const project: AgentCoreProjectSpec = {
      name: config.projectName,
      version: SCHEMA_VERSION,
      agents: [agent],
      memories,
      credentials,
    };

    await configIO.writeProjectSpec(project);
  }
}
