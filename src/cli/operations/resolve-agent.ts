import { ConfigIO } from '../../lib';
import type { AgentCoreProjectSpec, AwsDeploymentTargets, DeployedState } from '../../schema';

export interface DeployedProjectConfig {
  project: AgentCoreProjectSpec;
  deployedState: DeployedState;
  awsTargets: AwsDeploymentTargets;
}

export interface ResolvedAgent {
  agentName: string;
  targetName: string;
  region: string;
  accountId: string;
  runtimeId: string;
}

/**
 * Loads the configuration files needed for agent resolution.
 */
export async function loadDeployedProjectConfig(configIO: ConfigIO = new ConfigIO()): Promise<DeployedProjectConfig> {
  return {
    project: await configIO.readProjectSpec(),
    deployedState: await configIO.readDeployedState(),
    awsTargets: await configIO.readAWSDeploymentTargets(),
  };
}

/**
 * Resolves which deployed agent to target from configuration and options.
 */
export function resolveAgent(
  context: DeployedProjectConfig,
  options: { runtime?: string }
): { success: true; agent: ResolvedAgent } | { success: false; error: string } {
  const { project, deployedState, awsTargets } = context;

  if (project.runtimes.length === 0) {
    return { success: false, error: 'No runtimes defined in agentcore.json' };
  }

  // Resolve runtime
  const runtimeNames = project.runtimes.map(a => a.name);

  if (!options.runtime && project.runtimes.length > 1) {
    return {
      success: false,
      error: `Multiple runtimes found. Use --runtime to specify one: ${runtimeNames.join(', ')}`,
    };
  }

  const agentSpec = options.runtime ? project.runtimes.find(a => a.name === options.runtime) : project.runtimes[0];

  if (options.runtime && !agentSpec) {
    return {
      success: false,
      error: `Runtime '${options.runtime}' not found. Available: ${runtimeNames.join(', ')}`,
    };
  }

  if (!agentSpec) {
    return { success: false, error: 'No runtimes defined in agentcore.json' };
  }

  // Resolve target
  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    return { success: false, error: 'No deployed targets found. Run `agentcore deploy` first.' };
  }
  const selectedTargetName = targetNames[0]!;

  const targetState = deployedState.targets[selectedTargetName];
  const targetConfig = awsTargets.find(t => t.name === selectedTargetName);

  if (!targetConfig) {
    return { success: false, error: `Target config '${selectedTargetName}' not found in aws-targets` };
  }

  // Get the deployed state for this specific agent
  const agentState = targetState?.resources?.runtimes?.[agentSpec.name];

  if (!agentState) {
    return {
      success: false,
      error: `Runtime '${agentSpec.name}' is not deployed to target '${selectedTargetName}'. Run 'agentcore deploy' first.`,
    };
  }

  return {
    success: true,
    agent: {
      agentName: agentSpec.name,
      targetName: selectedTargetName,
      region: targetConfig.region,
      accountId: targetConfig.account,
      runtimeId: agentState.runtimeId,
    },
  };
}
