import { ConfigIO } from '../../../lib';
import type { AgentInfo } from './types';

export async function listAgents(options: { configIO?: ConfigIO; deployTarget?: string } = {}): Promise<AgentInfo[]> {
  const configIO = options.configIO ?? new ConfigIO();

  const deployedState = await configIO.readDeployedState();
  const projectSpec = await configIO.readProjectSpec();

  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) return [];

  const targetName = options.deployTarget ?? targetNames[0]!;
  const target = deployedState.targets[targetName];
  if (!target) return [];

  const deployedAgents = target.resources?.runtimes ?? {};

  const agents: AgentInfo[] = [];

  for (const agent of projectSpec.runtimes) {
    const deployed = deployedAgents[agent.name];
    if (!deployed?.runtimeArn) continue;

    agents.push({
      name: agent.name,
      authType: agent.authorizerType ?? 'AWS_IAM',
    });
  }

  return agents;
}
