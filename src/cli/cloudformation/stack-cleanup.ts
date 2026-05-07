import { getCredentialProvider } from '../aws';
import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
  ListChangeSetsCommand,
} from '@aws-sdk/client-cloudformation';

/**
 * CloudFormation change-set `Status` values that indicate the change set
 * itself never reached a successful state (so deleting the stack is safe).
 *
 * `CREATE_COMPLETE` is also safe **iff** the corresponding `ExecutionStatus`
 * indicates the change set was never actually executed (see
 * {@link NON_EXECUTED_EXECUTION_STATUSES}). The combined check is performed
 * inline in {@link recoverReviewInProgressStack}.
 */
const NON_EXECUTED_CHANGE_SET_STATUSES = new Set(['FAILED', 'OBSOLETE']);

/**
 * CloudFormation change-set `ExecutionStatus` values that indicate the change
 * set has not been executed against the stack.
 *
 * - `UNAVAILABLE` — change set creation failed; cannot be executed.
 * - `AVAILABLE`   — change set is ready to execute but hasn't been.
 * - `EXECUTE_FAILED` — execution attempt failed; CloudFormation does not
 *   apply partial changes for `CHANGE_SET_TYPE=CREATE` so the stack stays
 *   resource-free.
 * - `OBSOLETE` — superseded by another change set; will not execute.
 */
const NON_EXECUTED_EXECUTION_STATUSES = new Set(['UNAVAILABLE', 'AVAILABLE', 'EXECUTE_FAILED', 'OBSOLETE']);

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
  /**
   * Optional logger callback for non-fatal observations (e.g. "no change sets
   * found, proceeding because stack is REVIEW_IN_PROGRESS"). Tests and the
   * deploy flow can hook this in; defaults to a no-op so the helper is
   * usable from any context.
   */
  onWarning?: (message: string) => void;
  /**
   * Optional progress callback invoked once before every poll iteration with
   * the current `StackStatus` (or `'unknown'` if the describe failed without
   * a recognised stack-missing error). Use this to emit a heartbeat so users
   * don't think the recovery flow has hung. Receives the elapsed time in ms
   * since the helper started.
   */
  onProgress?: (info: { stackStatus: string; elapsedMs: number }) => void;
}

/**
 * Returns true when the given error indicates the stack does not exist.
 * Robust against AWS SDK v3 surface variations: the literal name was
 * historically `ValidationError`, but some service exception subclasses
 * report `ValidationException` or operation-specific names. The error
 * message ("Stack with id X does not exist") is the most stable signal,
 * so fall back to it.
 */
function isStackNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'ValidationError' || err.name === 'ValidationException') return true;
  return /does not exist/i.test(err.message);
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

  const startedAt = Date.now();

  // 1. Verify the stack is actually in REVIEW_IN_PROGRESS
  let describe;
  try {
    describe = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  } catch (err: unknown) {
    if (isStackNotFoundError(err)) {
      throw new Error(`Stack "${stackName}" not found in region ${region}.`);
    }
    throw err;
  }
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

  // 3. Refuse to delete if any change set was successfully executed.
  //    A change set is "non-executed" when its Status is FAILED/OBSOLETE
  //    *or* its ExecutionStatus is in NON_EXECUTED_EXECUTION_STATUSES (which
  //    covers the common `Status=CREATE_COMPLETE, ExecutionStatus=AVAILABLE`
  //    case that triggered REVIEW_IN_PROGRESS in the first place).
  const isNonExecuted = (cs: { Status?: string; ExecutionStatus?: string }) => {
    if (cs.Status && NON_EXECUTED_CHANGE_SET_STATUSES.has(cs.Status)) return true;
    if (cs.ExecutionStatus && NON_EXECUTED_EXECUTION_STATUSES.has(cs.ExecutionStatus)) return true;
    return false;
  };

  // Empty change-set list is a corner case: CloudFormation auto-purges old
  // change sets after a while, and users can also delete them manually. The
  // stack's `REVIEW_IN_PROGRESS` status is itself authoritative evidence that
  // no resources have been provisioned, so we proceed with deletion but emit
  // a warning so operators know the safety check could not be performed
  // through change-set inspection.
  if (changeSetSummaries.length === 0) {
    options.onWarning?.(
      `Stack "${stackName}" is in REVIEW_IN_PROGRESS but has no change sets to inspect. ` +
        `Proceeding with deletion based on stack status alone (REVIEW_IN_PROGRESS implies no resources).`
    );
  } else {
    const allNonExecuted = changeSetSummaries.every(isNonExecuted);
    if (!allNonExecuted) {
      throw new Error(
        `Refusing to auto-delete stack "${stackName}": at least one change set has been executed. ` +
          `Inspect the stack in the AWS console before attempting recovery.`
      );
    }
  }

  // `Array#every` returns true for empty arrays, which matches the
  // warn-and-proceed semantics of the empty-summaries branch above.
  const allNonExecuted = changeSetSummaries.every(isNonExecuted);

  // 4. Delete the stack
  await cfn.send(new DeleteStackCommand({ StackName: stackName }));

  // 5. Poll until the stack disappears or hits an unrecoverable state.
  //    Run the body once first (do/while) so a delete that completes
  //    synchronously — i.e. DescribeStacks immediately returns
  //    DELETE_COMPLETE or NotFound — is recognised even when the deadline
  //    has already lapsed (e.g. timeoutMs=0). For non-terminal first
  //    responses (DELETE_IN_PROGRESS), the loop will still time out as
  //    expected.
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const resp = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
      const current = resp.Stacks?.[0];
      const currentStatus = current?.StackStatus ?? 'unknown';
      options.onProgress?.({ stackStatus: currentStatus, elapsedMs: Date.now() - startedAt });
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
      // Stack no longer exists — deletion succeeded. Match on both
      // ValidationError / ValidationException and "does not exist" so we
      // are robust against AWS SDK v3 surface variations (see
      // https://github.com/aws/agentcore-cli/issues/907 reviewer notes).
      if (isStackNotFoundError(err)) {
        options.onProgress?.({ stackStatus: 'DELETE_COMPLETE', elapsedMs: Date.now() - startedAt });
        return {
          deleted: true,
          changeSetCount: changeSetSummaries.length,
          allChangeSetsNonExecuted: allNonExecuted,
        };
      }
      throw err;
    }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  } while (Date.now() < deadline);

  throw new Error(`Timed out waiting for stack "${stackName}" to delete after ${timeoutMs}ms.`);
}
