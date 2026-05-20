import { ResourceNotFoundError, ValidationError } from '../../../lib';
import type { ConfigIO } from '../../../lib';
import type {
  AgentCoreProjectSpec,
  AgentEnvSpec,
  AwsDeploymentTarget,
  AwsDeploymentTargets,
  DeployedState,
} from '../../../schema';
import { canFetchRuntimeToken, fetchRuntimeToken } from '../../operations/fetch-access';
import { generateSessionId } from '../../operations/session';

export interface ResolveInvokeInput {
  project: AgentCoreProjectSpec;
  deployedState: DeployedState;
  awsTargets: AwsDeploymentTargets;
  agentName?: string;
  targetName?: string;
  bearerToken?: string;
  sessionId?: string;
  configIO?: ConfigIO;
}

export interface ResolvedInvokeTarget {
  agentSpec: AgentEnvSpec;
  targetName: string;
  targetConfig: AwsDeploymentTarget;
  region: string;
  runtimeArn: string;
  bearerToken?: string;
  sessionId?: string;
  baggage?: string;
}

export type ResolveInvokeResult = ({ success: true } & ResolvedInvokeTarget) | { success: false; error: Error };

export async function resolveInvokeTarget(input: ResolveInvokeInput): Promise<ResolveInvokeResult> {
  const { project, deployedState, awsTargets } = input;

  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    return {
      success: false,
      error: new ResourceNotFoundError('No deployed targets found. Run `agentcore deploy` first.'),
    };
  }

  const selectedTargetName = input.targetName ?? targetNames[0]!;

  if (input.targetName && !targetNames.includes(input.targetName)) {
    return {
      success: false,
      error: new ResourceNotFoundError(`Target '${input.targetName}' not found. Available: ${targetNames.join(', ')}`),
    };
  }

  const targetState = deployedState.targets[selectedTargetName];
  const targetConfig = awsTargets.find(t => t.name === selectedTargetName);

  if (!targetConfig) {
    return {
      success: false,
      error: new ResourceNotFoundError(`Target config '${selectedTargetName}' not found in aws-targets`),
    };
  }

  if (project.runtimes.length === 0) {
    return { success: false, error: new ValidationError('No agents defined in configuration') };
  }

  const agentNames = project.runtimes.map(a => a.name);

  if (!input.agentName && project.runtimes.length > 1) {
    return {
      success: false,
      error: new ValidationError(`Multiple runtimes found. Use --runtime to specify one: ${agentNames.join(', ')}`),
    };
  }

  const agentSpec = input.agentName ? project.runtimes.find(a => a.name === input.agentName) : project.runtimes[0];

  if (input.agentName && !agentSpec) {
    return {
      success: false,
      error: new ResourceNotFoundError(`Agent '${input.agentName}' not found. Available: ${agentNames.join(', ')}`),
    };
  }

  if (!agentSpec) {
    return { success: false, error: new ValidationError('No agents defined in configuration') };
  }

  const agentState = targetState?.resources?.runtimes?.[agentSpec.name];

  if (!agentState) {
    return {
      success: false,
      error: new ValidationError(`Agent '${agentSpec.name}' is not deployed to target '${selectedTargetName}'`),
    };
  }

  // Build config bundle baggage if a bundle is associated with this agent
  const deployedBundles = targetState?.resources?.configBundles ?? {};
  let baggage: string | undefined;
  const bundleSpec = project.configBundles?.find(b => {
    const keys = Object.keys(b.components ?? {});
    return keys.some(k => k === `{{runtime:${agentSpec.name}}}`);
  });
  if (bundleSpec) {
    const bundleState = deployedBundles[bundleSpec.name];
    if (bundleState?.bundleArn && bundleState?.versionId) {
      baggage = `aws.agentcore.configbundle_arn=${encodeURIComponent(bundleState.bundleArn)},aws.agentcore.configbundle_version=${encodeURIComponent(bundleState.versionId)}`;
    }
  }

  // Auto-fetch bearer token for CUSTOM_JWT agents when not provided
  let bearerToken = input.bearerToken;
  if (agentSpec.authorizerType === 'CUSTOM_JWT' && !bearerToken) {
    const fetchOpts = input.configIO ? { configIO: input.configIO } : undefined;
    const canFetch = await canFetchRuntimeToken(agentSpec.name, fetchOpts);
    if (canFetch) {
      try {
        const tokenResult = await fetchRuntimeToken(agentSpec.name, {
          ...fetchOpts,
          deployTarget: selectedTargetName,
        });
        bearerToken = tokenResult.token;
      } catch (err) {
        return {
          success: false,
          error: new ValidationError(
            `CUSTOM_JWT agent requires a bearer token. Auto-fetch failed: ${err instanceof Error ? err.message : String(err)}\nProvide one manually with --bearer-token.`,
            { cause: err }
          ),
        };
      }
    } else {
      return {
        success: false,
        error: new ValidationError(
          `Agent '${agentSpec.name}' is configured for CUSTOM_JWT but no bearer token is available.\nEither provide --bearer-token or re-add the agent with --client-id and --client-secret to enable auto-fetch.`
        ),
      };
    }
  }

  // When invoking with a bearer token, generate a session ID if not provided
  let sessionId = input.sessionId;
  if (bearerToken && !sessionId) {
    sessionId = generateSessionId();
  }

  return {
    success: true,
    agentSpec,
    targetName: selectedTargetName,
    targetConfig,
    region: targetConfig.region,
    runtimeArn: agentState.runtimeArn,
    bearerToken,
    sessionId,
    baggage,
  };
}
