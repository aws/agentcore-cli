import { getCredentialProvider } from '../aws';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

/**
 * CloudFormation stack statuses that indicate the stack is in a transitional state
 * and cannot be updated until the current operation completes.
 */
const IN_PROGRESS_STATUSES = new Set([
  'CREATE_IN_PROGRESS',
  'UPDATE_IN_PROGRESS',
  'DELETE_IN_PROGRESS',
  'ROLLBACK_IN_PROGRESS',
  'UPDATE_ROLLBACK_IN_PROGRESS',
  'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
  'DELETE_COMPLETE_CLEANUP_IN_PROGRESS',
  'IMPORT_IN_PROGRESS',
  'IMPORT_ROLLBACK_IN_PROGRESS',
]);

/**
 * `REVIEW_IN_PROGRESS` is special: it occurs after `CreateChangeSet` with
 * `ChangeSetType=CREATE` *before* a successful execute. When the underlying
 * change set fails CloudFormation early-validation, the stack is permanently
 * stuck in this state with zero resources.
 *
 * The `isRecoverableReview` flag set below merely advertises eligibility for
 * the `agentcore deploy --recover` flow; it does **not** itself prove the
 * stack is empty. The real safety check (verifying that no change set has
 * been executed) lives in `recoverReviewInProgressStack`, which is invoked
 * by the recover flow before the stack is deleted.
 *
 * See: https://github.com/aws/agentcore-cli/issues/907
 */
const RECOVERABLE_REVIEW_STATUSES = new Set(['REVIEW_IN_PROGRESS']);

/**
 * CloudFormation stack statuses that indicate the stack is in a failed state
 * and may require manual intervention.
 */
const FAILED_STATUSES = new Set([
  'CREATE_FAILED',
  'ROLLBACK_FAILED',
  'DELETE_FAILED',
  'UPDATE_ROLLBACK_FAILED',
  'IMPORT_ROLLBACK_FAILED',
]);

export interface StackStatusResult {
  /** Whether the stack can be deployed to (is in a stable, deployable state) */
  canDeploy: boolean;
  /** Whether the stack exists */
  exists: boolean;
  /** The current stack status, if the stack exists */
  status?: string;
  /** User-friendly message explaining why deployment is blocked */
  message?: string;
  /**
   * True when the stack is in `REVIEW_IN_PROGRESS` and has no successfully
   * executed change sets — i.e. it can be cleaned up via `DeleteStack` and the
   * deploy retried. Callers may offer a `--recover` flow when this is set.
   */
  isRecoverableReview?: boolean;
}

/**
 * Check if a CloudFormation stack is in a deployable state.
 *
 * Returns information about whether the stack can be deployed to:
 * - If the stack doesn't exist, deployment can proceed (will create)
 * - If the stack is in a stable state (*_COMPLETE), deployment can proceed
 * - If the stack is in progress, deployment must wait
 * - If the stack is in a failed state, deployment may require manual intervention
 * - If the stack is in `REVIEW_IN_PROGRESS`, it can usually be auto-recovered
 */
export async function checkStackStatus(region: string, stackName: string): Promise<StackStatusResult> {
  const cfn = new CloudFormationClient({ region, credentials: getCredentialProvider() });

  try {
    const resp = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = resp.Stacks?.[0];

    if (!stack?.StackStatus) {
      // Stack exists but no status - shouldn't happen, but treat as deployable
      return { canDeploy: true, exists: true };
    }

    const status = stack.StackStatus;

    // Stuck in REVIEW_IN_PROGRESS — treat as recoverable, with a clearer message
    if (RECOVERABLE_REVIEW_STATUSES.has(status)) {
      return {
        canDeploy: false,
        exists: true,
        status,
        isRecoverableReview: true,
        message:
          `Stack "${stackName}" is in ${status} state. This usually means a previous deployment ` +
          `failed CloudFormation early validation (for example, an unsupported runtime in this region). ` +
          `Run \`agentcore deploy --recover\` to delete the empty stack and retry.`,
      };
    }

    // Check if stack is in a transitional state
    if (IN_PROGRESS_STATUSES.has(status)) {
      return {
        canDeploy: false,
        exists: true,
        status,
        message: `Stack "${stackName}" is currently in ${status} state. Please wait for the operation to complete before deploying.`,
      };
    }

    // Check if stack is in a failed state
    if (FAILED_STATUSES.has(status)) {
      return {
        canDeploy: false,
        exists: true,
        status,
        message: `Stack "${stackName}" is in ${status} state. Manual intervention may be required before deploying.`,
      };
    }

    // Stack is in a stable state - can deploy
    return { canDeploy: true, exists: true, status };
  } catch (err: unknown) {
    // Stack doesn't exist - safe to deploy (will create new stack)
    if (err instanceof Error && err.name === 'ValidationError') {
      return { canDeploy: true, exists: false };
    }
    throw err;
  }
}

/**
 * Check multiple stacks and return the first one that blocks deployment.
 * Returns null if all stacks are deployable.
 */
export async function checkStacksStatus(
  region: string,
  stackNames: string[]
): Promise<{ stackName: string; result: StackStatusResult } | null> {
  for (const stackName of stackNames) {
    const result = await checkStackStatus(region, stackName);
    if (!result.canDeploy) {
      return { stackName, result };
    }
  }
  return null;
}
