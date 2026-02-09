import { ConfigIO, requireConfigRoot } from '../../../../lib';
import type { AgentCoreProjectSpec } from '../../../../schema';
import { SCHEMA_VERSION } from '../../../constants';
import { AgentAlreadyExistsError } from '../../../errors';
import type { GenerateConfig } from '../../../tui/screens/generate/types';
import type { CredentialStrategy } from '../../identity/create-identity';
import { mapGenerateConfigToAgent, mapGenerateInputToMemories, mapModelProviderToCredentials } from './schema-mapper';

export interface WriteAgentOptions {
  configBaseDir?: string;
  credentialStrategy?: CredentialStrategy;
}

/**
 * Writes a new agent (and associated resources) to the agentcore.json project config.
 *
 * In v2 schema:
 * - Agent goes to project.agents[]
 * - Memory resources go to project.memories[]
 * - Credential resources go to project.credentials[] (unless strategy.reuse)
 */
export async function writeAgentToProject(config: GenerateConfig, options?: WriteAgentOptions): Promise<void> {
  const configBaseDir = options?.configBaseDir ?? requireConfigRoot();
  const configIO = new ConfigIO({ baseDir: configBaseDir });
  const strategy = options?.credentialStrategy;

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

    // Add resources to project
    project.agents.push(agent);
    project.memories.push(...memories);

    // Handle credentials based on strategy
    if (strategy) {
      if (!strategy.reuse) {
        const credentials = mapModelProviderToCredentials(config.modelProvider, project.name);
        if (credentials.length > 0) {
          credentials[0]!.name = strategy.credentialName;
          project.credentials.push(...credentials);
        }
      }
    } else {
      // Backward compatibility: no strategy provided
      const credentials = mapModelProviderToCredentials(config.modelProvider, project.name);
      project.credentials.push(...credentials);
    }

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
