import { ResourceNotFoundError, toError } from '../../../lib';
import type { Result } from '../../../lib/result';
import type { OnlineEvalExecutionStatus } from '../../aws/agentcore-control';
import { updateOnlineEvalExecutionStatus } from '../../aws/agentcore-control';
import { loadDeployedProjectConfig } from '../resolve-agent';
import type { OnlineEvalActionOptions } from './types';

export type PauseResumeResult = Result<{ configId?: string; executionStatus?: string }>;

async function resolveOnlineEvalConfig(
  configName: string
): Promise<{ success: true; configId: string; region: string } | { success: false; error: string }> {
  const context = await loadDeployedProjectConfig();
  const targetNames = Object.keys(context.deployedState.targets);

  if (targetNames.length === 0) {
    return { success: false, error: 'No deployed targets found. Run `agentcore deploy` first.' };
  }

  const targetName = targetNames[0]!;
  const targetResources = context.deployedState.targets[targetName]?.resources;
  const deployedConfig = targetResources?.onlineEvalConfigs?.[configName];

  if (!deployedConfig) {
    return {
      success: false,
      error: `Online eval config "${configName}" not found in deployed state. Has it been deployed?`,
    };
  }

  const targetConfig = context.awsTargets.find(t => t.name === targetName);
  if (!targetConfig) {
    return { success: false, error: `Target config "${targetName}" not found in aws-targets.` };
  }

  return {
    success: true,
    configId: deployedConfig.onlineEvaluationConfigId,
    region: targetConfig.region,
  };
}

/**
 * Parse an online eval config ARN to extract the config ID and region.
 * ARN format: arn:aws:bedrock-agentcore:<region>:<account>:online-evaluation-config/<configId>
 */
function parseOnlineEvalConfigArn(
  arn: string,
  regionOverride?: string
): { success: true; configId: string; region: string } | { success: false; error: string } {
  const parts = arn.split(':');
  if (parts.length < 6 || !arn.startsWith('arn:')) {
    return { success: false, error: `Invalid online eval config ARN: ${arn}` };
  }

  const region = regionOverride ?? parts[3];
  if (!region) {
    return { success: false, error: 'Could not determine region from ARN. Use --region to specify.' };
  }

  const resource = parts.slice(5).join(':');
  const match = /online-evaluation-config\/(.+)$/.exec(resource);
  if (!match) {
    return { success: false, error: `Could not extract config ID from ARN: ${arn}` };
  }

  return { success: true, configId: match[1]!, region };
}

/**
 * Resolve config ID and region from either a project config name or an ARN.
 */
async function resolveConfig(
  options: OnlineEvalActionOptions
): Promise<{ success: true; configId: string; region: string } | { success: false; error: string }> {
  if (options.arn) {
    return parseOnlineEvalConfigArn(options.arn, options.region);
  }
  return resolveOnlineEvalConfig(options.name);
}

export async function handlePauseResume(
  options: OnlineEvalActionOptions,
  action: 'pause' | 'resume'
): Promise<PauseResumeResult> {
  const resolution = await resolveConfig(options);
  if (!resolution.success) {
    return { success: false, error: new ResourceNotFoundError(resolution.error) };
  }

  const executionStatus: OnlineEvalExecutionStatus = action === 'pause' ? 'DISABLED' : 'ENABLED';

  try {
    const result = await updateOnlineEvalExecutionStatus({
      region: resolution.region,
      onlineEvaluationConfigId: resolution.configId,
      executionStatus,
    });

    return {
      success: true,
      configId: result.configId,
      executionStatus: result.executionStatus,
    };
  } catch (err) {
    return { success: false, error: toError(err) };
  }
}
