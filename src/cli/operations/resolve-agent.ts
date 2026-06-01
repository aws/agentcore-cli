import { ConfigIO } from '../../lib';
import type { AgentCoreProjectSpec, AwsDeploymentTargets, DeployedState } from '../../schema';
import { getHarness } from '../aws/agentcore-harness';

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

/**
 * Resolves a harness to a ResolvedAgent by looking up deployed state and
 * fetching the underlying agentRuntimeArn via the GetHarness API.
 */
export async function resolveHarness(
  context: DeployedProjectConfig,
  harnessName: string
): Promise<{ success: true; agent: ResolvedAgent } | { success: false; error: string }> {
  const { project, deployedState, awsTargets } = context;

  const harnesses = project.harnesses ?? [];
  const harnessSpec = harnesses.find(h => h.name === harnessName);
  if (!harnessSpec) {
    const available = harnesses.map(h => h.name);
    return {
      success: false,
      error:
        available.length > 0
          ? `Harness '${harnessName}' not found. Available: ${available.join(', ')}`
          : 'No harnesses defined in agentcore.json',
    };
  }

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

  const harnessState = targetState?.resources?.harnesses?.[harnessName];
  if (!harnessState) {
    return {
      success: false,
      error: `Harness '${harnessName}' is not deployed to target '${selectedTargetName}'. Run 'agentcore deploy' first.`,
    };
  }

  let runtimeId: string | undefined;

  if (harnessState.agentRuntimeArn) {
    const arnMatch = /runtime\/([^/]+)/.exec(harnessState.agentRuntimeArn);
    if (arnMatch) {
      runtimeId = arnMatch[1];
    }
  }

  if (!runtimeId) {
    try {
      await getHarness({ region: targetConfig.region, harnessId: harnessState.harnessId });
      runtimeId = harnessState.harnessId;
    } catch (err) {
      return {
        success: false,
        error: `Failed to resolve runtime for harness '${harnessName}': ${(err as Error).message}`,
      };
    }
  }

  if (!runtimeId) {
    return {
      success: false,
      error: `Could not resolve runtime ID for harness '${harnessName}'. Re-deploy to populate agentRuntimeArn.`,
    };
  }

  return {
    success: true,
    agent: {
      agentName: harnessName,
      targetName: selectedTargetName,
      region: targetConfig.region,
      accountId: targetConfig.account,
      runtimeId,
    },
  };
}

/**
 * Resolves either an agent runtime or a harness to a ResolvedAgent.
 * - If --harness is specified, resolves that harness.
 * - If --runtime is specified, resolves that runtime.
 * - If neither is specified, auto-selects: single runtime wins, or if no runtimes
 *   but harnesses exist, auto-selects the single harness.
 */
export async function resolveAgentOrHarness(
  context: DeployedProjectConfig,
  options: { runtime?: string; harness?: string }
): Promise<{ success: true; agent: ResolvedAgent } | { success: false; error: string }> {
  if (options.harness && options.runtime) {
    return { success: false, error: 'Cannot specify both --harness and --runtime' };
  }

  if (options.harness) {
    return resolveHarness(context, options.harness);
  }

  if (options.runtime || context.project.runtimes.length > 0) {
    return resolveAgent(context, options);
  }

  const harnesses = context.project.harnesses ?? [];
  if (harnesses.length === 0) {
    return { success: false, error: 'No runtimes or harnesses defined in agentcore.json' };
  }

  if (harnesses.length > 1) {
    const names = harnesses.map(h => h.name);
    return {
      success: false,
      error: `Multiple harnesses found. Use --harness to specify one: ${names.join(', ')}`,
    };
  }

  return resolveHarness(context, harnesses[0]!.name);
}
