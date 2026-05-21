/**
 * Shared agent resolution logic.
 *
 * Resolves a deployed agent to its full invocation context: runtimeArn, region,
 * config bundle baggage, and bearer token. Called ONCE before invoking —
 * reused across multiple invocations (e.g., dataset eval scenarios).
 *
 * Used by:
 * - `agentcore invoke` (commands/invoke/action.ts)
 * - Dataset eval scenario executor (operations/eval/shared/scenario-executor.ts)
 */
import type { AgentCoreProjectSpec, AwsDeploymentTargets, DeployedState } from '../../../schema';
import { canFetchRuntimeToken, fetchRuntimeToken } from '../fetch-access';

export interface AgentContext {
  runtimeArn: string;
  runtimeId: string;
  region: string;
  endpoint?: string;
  agentName: string;
  baggage?: string;
  bearerToken?: string;
}

export interface ResolveAgentContextOptions {
  project: AgentCoreProjectSpec;
  deployedState: DeployedState;
  awsTargets: AwsDeploymentTargets;
  agentName?: string;
  endpoint?: string;
  targetName?: string;
}

/**
 * Resolve a deployed agent to its invocation context.
 * Handles: target resolution, agent lookup, config bundle baggage, bearer token.
 */
export async function resolveAgentContext(options: ResolveAgentContextOptions): Promise<AgentContext> {
  const { project, deployedState, awsTargets } = options;

  // Resolve target
  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    throw new Error('No deployed targets found. Run `agentcore deploy` first.');
  }

  const selectedTargetName = options.targetName ?? targetNames[0]!;

  if (options.targetName && !targetNames.includes(options.targetName)) {
    throw new Error(`Target '${options.targetName}' not found. Available: ${targetNames.join(', ')}`);
  }

  const targetState = deployedState.targets[selectedTargetName];
  const targetConfig = awsTargets.find(t => t.name === selectedTargetName);

  if (!targetConfig) {
    throw new Error(`Target config '${selectedTargetName}' not found in aws-targets`);
  }

  // Resolve agent
  if (project.runtimes.length === 0) {
    throw new Error('No agents defined in configuration');
  }

  const agentSpec = options.agentName ? project.runtimes.find(a => a.name === options.agentName) : project.runtimes[0];

  if (!agentSpec) {
    const available = project.runtimes.map(a => a.name).join(', ');
    throw new Error(`Agent '${options.agentName}' not found. Available: ${available}`);
  }

  const agentState = targetState?.resources?.runtimes?.[agentSpec.name];

  if (!agentState) {
    throw new Error(`Agent '${agentSpec.name}' is not deployed to target '${selectedTargetName}'`);
  }

  // Resolve config bundle baggage
  let baggage: string | undefined;
  const bundleSpec = project.configBundles?.find(b => {
    const keys = Object.keys(b.components ?? {});
    return keys.some(k => k === `{{runtime:${agentSpec.name}}}`);
  });
  if (bundleSpec) {
    const deployedBundles = targetState?.resources?.configBundles ?? {};
    const bundleState = deployedBundles[bundleSpec.name];
    if (bundleState?.bundleArn && bundleState?.versionId) {
      baggage = `aws.agentcore.configbundle_arn=${encodeURIComponent(bundleState.bundleArn)},aws.agentcore.configbundle_version=${encodeURIComponent(bundleState.versionId)}`;
    }
  }

  // Resolve bearer token for CUSTOM_JWT agents
  let bearerToken: string | undefined;
  if (agentSpec.authorizerType === 'CUSTOM_JWT') {
    const canFetch = await canFetchRuntimeToken(agentSpec.name);
    if (canFetch) {
      try {
        const tokenResult = await fetchRuntimeToken(agentSpec.name, { deployTarget: selectedTargetName });
        bearerToken = tokenResult.token;
      } catch (err) {
        throw new Error(
          `CUSTOM_JWT agent requires a bearer token. Auto-fetch failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else {
      throw new Error(
        `Agent '${agentSpec.name}' is configured for CUSTOM_JWT but no bearer token is available. ` +
          `Re-add the agent with --client-id and --client-secret to enable auto-fetch.`
      );
    }
  }

  return {
    runtimeArn: agentState.runtimeArn,
    runtimeId: agentState.runtimeId,
    region: targetConfig.region,
    endpoint: options.endpoint,
    agentName: agentSpec.name,
    baggage,
    bearerToken,
  };
}
