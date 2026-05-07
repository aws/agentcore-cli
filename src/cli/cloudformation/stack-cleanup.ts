import { getCredentialProvider } from '../aws';
import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
  ListChangeSetsCommand,
} from '@aws-sdk/client-cloudformation';

/**
 * CloudFormation change set execution / status values that indicate a change
 * set has *not* been successfully executed and the stack therefore contains
 * no resources from it.
 */
const NON_EXECUTED_CHANGE_SET_STATUSES = new Set(['FAILED', 'OBSOLETE']);

export interface RecoverReviewInProgressOptions {
  /** Maximum total time to wait for stack deletion (ms). Default: 5 minutes. */
  timeoutMs?: number;
  /** Polling interval between status checks (ms). Default: 5 seconds. */
  pollIntervalMs?: number;
  /**
   * Optional CloudFormation client override (used in tests). When omitted, a
   * new client is constructed using the configured region and credentials.
   */
  client?: CloudFormationClient;
}

export interface RecoverReviewInProgressResult {
  /** Whether the stack was successfully deleted. */
  deleted: boolean;
  /** Number of change sets that were inspected. */
  changeSetCount: number;
  /** Whether all change sets were in a non-executed (recoverable) state. */
  allChangeSetsNonExecuted: boolean;
}

/**
 * Recover a CloudFormation stack stuck in `REVIEW_IN_PROGRESS`.
 *
 * This state happens when a `CreateChangeSet` (with `ChangeSetType=CREATE`)
 * fails CloudFormation pre-validation (e.g. `AWS::EarlyValidation::PropertyValidation`).
 * The resulting stack has no resources but cannot be updated; the only way
 * forward is to delete it.
 *
 * To avoid destructive surprises, this helper refuses to delete the stack
 * unless **all** of its change sets are in a non-executed terminal state
 * (`FAILED` or `OBSOLETE`). If any change set has been successfully executed,
 * it throws an error and asks the user to inspect the stack manually.
 */
export async function recoverReviewInProgressStack(
  region: string,
  stackName: string,
  options: RecoverReviewInProgressOptions = {}
): Promise<RecoverReviewInProgressResult> {
  const cfn = options.client ?? new CloudFormationClient({ region, credentials: getCredentialProvider() });
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;

  // 1. Verify the stack is actually in REVIEW_IN_PROGRESS
  const describe = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = describe.Stacks?.[0];
  if (!stack) {
    throw new Error(`Stack "${stackName}" not found in region ${region}.`);
  }
  if (stack.StackStatus !== 'REVIEW_IN_PROGRESS') {
    throw new Error(
      `Cannot auto-recover stack "${stackName}": expected status REVIEW_IN_PROGRESS but found ${stack.StackStatus}. ` +
        `Use the AWS console or CLI to resolve this state manually.`
    );
  }

  // 2. List change sets, paginating if necessary
  const changeSetSummaries: { Status?: string; ExecutionStatus?: string }[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await cfn.send(new ListChangeSetsCommand({ StackName: stackName, NextToken: nextToken }));
    if (resp.Summaries) changeSetSummaries.push(...resp.Summaries);
    nextToken = resp.NextToken;
  } while (nextToken);

  // 3. Refuse to delete if any change set was successfully executed
  const allNonExecuted = changeSetSummaries.every(
    cs =>
      (cs.Status && NON_EXECUTED_CHANGE_SET_STATUSES.has(cs.Status)) ||
      (cs.ExecutionStatus && NON_EXECUTED_CHANGE_SET_STATUSES.has(cs.ExecutionStatus)) ||
      // No status reported is treated as non-executed only if execution status agrees
      cs.ExecutionStatus === 'UNAVAILABLE'
  );

  if (changeSetSummaries.length > 0 && !allNonExecuted) {
    throw new Error(
      `Refusing to auto-delete stack "${stackName}": at least one change set has been executed. ` +
        `Inspect the stack in the AWS console before attempting recovery.`
    );
  }

  // 4. Delete the stack
  await cfn.send(new DeleteStackCommand({ StackName: stackName }));

  // 5. Poll until the stack disappears or hits an unrecoverable state
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      const current = resp.Stacks?.[0];
      if (!current || current.StackStatus === 'DELETE_COMPLETE') {
        return {
          deleted: true,
          changeSetCount: changeSetSummaries.length,
          allChangeSetsNonExecuted: allNonExecuted,
        };
      }
      if (current.StackStatus === 'DELETE_FAILED') {
        throw new Error(
          `Failed to delete stack "${stackName}": status ${current.StackStatus} ` +
            `(reason: ${current.StackStatusReason ?? 'unknown'}).`
        );
      }
    } catch (err: unknown) {
      // Stack no longer exists — deletion succeeded
      if (err instanceof Error && err.name === 'ValidationError') {
        return {
          deleted: true,
          changeSetCount: changeSetSummaries.length,
          allChangeSetsNonExecuted: allNonExecuted,
        };
      }
      throw err;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Timed out waiting for stack "${stackName}" to delete after ${timeoutMs}ms.`);
}
