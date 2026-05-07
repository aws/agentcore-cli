import type { OnlineEvalDeployedState } from '../../../schema/schemas/deployed-state';
import type { OnlineEvalConfig } from '../../../schema/schemas/primitives/online-eval-config';
import { updateOnlineEvalExecutionStatus } from '../../aws/agentcore-control';

// ============================================================================
// Types
// ============================================================================

export interface EnableOnlineEvalsOptions {
  region: string;
  onlineEvalConfigs: OnlineEvalConfig[];
  deployedOnlineEvalConfigs: Record<string, OnlineEvalDeployedState>;
}

export interface OnlineEvalEnableResult {
  configName: string;
  status: 'enabled' | 'skipped' | 'error';
  error?: string;
}

export interface EnableOnlineEvalsResult {
  results: OnlineEvalEnableResult[];
  hasErrors: boolean;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Enable online eval configs that have `enableOnCreate: true` in the project spec.
 *
 * CFN does not support EnableOnCreate on `AWS::BedrockAgentCore::OnlineEvaluationConfig`,
 * so configs always deploy as DISABLED. This post-deploy step enables them via API.
 *
 * Callers should only pass newly deployed configs (not previously existing ones) to
 * avoid re-enabling configs a customer intentionally disabled.
 */
export async function enableOnlineEvalConfigs(options: EnableOnlineEvalsOptions): Promise<EnableOnlineEvalsResult> {
  const { region, onlineEvalConfigs, deployedOnlineEvalConfigs } = options;
  const results: OnlineEvalEnableResult[] = [];

  for (const config of onlineEvalConfigs) {
    // Default enableOnCreate to true when not explicitly set
    if (config.enableOnCreate === false) {
      results.push({ configName: config.name, status: 'skipped' });
      continue;
    }

    const deployed = deployedOnlineEvalConfigs[config.name];
    if (!deployed) {
      results.push({
        configName: config.name,
        status: 'error',
        error: `Online eval config "${config.name}" not found in deployed state`,
      });
      continue;
    }

    try {
      await updateOnlineEvalExecutionStatus({
        region,
        onlineEvaluationConfigId: deployed.onlineEvaluationConfigId,
        executionStatus: 'ENABLED',
      });
      results.push({ configName: config.name, status: 'enabled' });
    } catch (err) {
      results.push({
        configName: config.name,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    results,
    hasErrors: results.some(r => r.status === 'error'),
  };
}
