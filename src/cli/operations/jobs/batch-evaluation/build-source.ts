/**
 * Batch-evaluation start-time helpers, extracted from the legacy run-batch-evaluation.ts:
 * serviceName / logGroupName construction, evaluator name→short-id resolution (distinct from the
 * recommendation ARN resolver), name validation/auto-generation, and the CloudWatch filter builder.
 */
import { ValidationError } from '../../../../lib';
import type { DeployedState } from '../../../../schema';
import type { CloudWatchFilterConfig } from '../../../aws/agentcore-batch-evaluation';
import { resolveEndpointName, runtimeLogGroup } from '../../../aws/cloudwatch';
import { BATCH_EVAL_NAME_REGEX } from '../shared/constants';

/**
 * Resolve evaluator references to the SHORT ids the batch API expects.
 * Handles "Builtin.Correctness", "arn:...:evaluator/Builtin.Correctness", or custom names
 * looked up in deployed state. (Opposite of the recommendation path, which resolves to full ARNs.)
 */
export function resolveBatchEvaluatorIds(deployedState: DeployedState, agent: string, evaluators: string[]): string[] {
  const targetResources = Object.values(deployedState.targets).find(t => t.resources?.runtimes?.[agent])?.resources;
  return evaluators.map(name => {
    const shortName = name.includes('evaluator/') ? name.split('evaluator/').pop()! : name;
    if (shortName.startsWith('Builtin.')) return shortName;
    const deployed = targetResources?.evaluators?.[shortName];
    if (deployed?.evaluatorId) return deployed.evaluatorId;
    return shortName; // pass-through; the service will reject an unknown id
  });
}

/** CloudWatch service name + log group for the agent's runtime traces. */
export function buildCloudWatchSource(
  projectName: string,
  agent: string,
  runtimeId: string,
  endpoint: string | undefined
): { serviceName: string; logGroupName: string } {
  const endpointName = resolveEndpointName(endpoint);
  // Service name in CW logs uses project_agent format without the CDK hash suffix.
  const serviceName = `${projectName}_${agent}.${endpointName}`;
  const logGroupName = runtimeLogGroup(runtimeId, endpoint);
  return { serviceName, logGroupName };
}

/** Validate an explicit name or auto-generate one. Throws ValidationError on a bad explicit name. */
export function resolveBatchEvalName(name: string | undefined, projectName: string, agent: string): string {
  if (name) {
    if (!BATCH_EVAL_NAME_REGEX.test(name)) {
      throw new ValidationError(
        `Batch evaluation name must start with a letter and contain only letters, digits, and underscores (max 48 chars). Got: "${name}"`
      );
    }
    return name;
  }
  return `${projectName}_${agent}_${Date.now()}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 48);
}

/**
 * Build the optional CloudWatch filter. The API takes EITHER sessionIds OR timeRange (never both);
 * sessionIds take precedence. Returns undefined when neither is provided (evaluate all in the log group).
 */
export function buildCloudWatchFilterConfig(
  sessionIds: string[] | undefined,
  lookbackDays: number | undefined
): CloudWatchFilterConfig | undefined {
  const effective = [...new Set(sessionIds ?? [])];
  if (effective.length > 0) {
    return { sessionIds: effective };
  }
  if (lookbackDays) {
    const endTime = new Date().toISOString();
    const startTime = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    return { timeRange: { startTime, endTime } };
  }
  return undefined;
}
