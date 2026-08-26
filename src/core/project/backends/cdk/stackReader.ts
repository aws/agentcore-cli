import type { Stack } from "@aws-sdk/client-cloudformation";
import { isStackNotFound } from "./environment";
import type { CdkCredentialProvider } from "./toolkit";

/**
 * Live state of a project's CloudFormation stack.
 *
 * Deployed state now stores only the stack ARN; the resource ARNs/IDs are read
 * back from CloudFormation on demand so they can never go stale. This is the
 * shape callers (e.g. `project status`) consume.
 */
export type StackState =
  | { kind: "not-deployed" }
  | { kind: "in-progress"; status: string }
  | { kind: "failed"; status: string }
  | { kind: "ready"; status: string; outputs: Record<string, string> };

// Terminal statuses where the stack's resources exist and its outputs are
// meaningful. UPDATE_ROLLBACK_COMPLETE is included: an update failed but rolled
// back to the previous working state, so the outputs still describe live
// resources. ROLLBACK_COMPLETE (a failed *create*) is not — it leaves no usable
// resources — so it falls through to "failed".
const READY_STATUSES = new Set([
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_COMPLETE",
  "IMPORT_COMPLETE",
  "IMPORT_ROLLBACK_COMPLETE",
]);

/** Reads a single stack by name, returning undefined when it does not exist. */
export type StackReader = (
  region: string,
  credentials: CdkCredentialProvider,
  stackName: string,
) => Promise<Stack | undefined>;

function outputsToRecord(outputs: Stack["Outputs"]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const { OutputKey, OutputValue } of outputs ?? []) {
    if (OutputKey !== undefined && OutputValue !== undefined) record[OutputKey] = OutputValue;
  }
  return record;
}

/**
 * Maps a described stack (or its absence) onto {@link StackState}.
 *
 * CloudFormation's lifecycle is the substance here: an in-flight operation has
 * no settled outputs, a rolled-back create is broken, and a deleted stack is
 * effectively not deployed. Only a settled, successful status yields outputs.
 */
export function classifyStack(stack: Stack | undefined): StackState {
  if (!stack) return { kind: "not-deployed" };

  const status = stack.StackStatus;
  // A stack described by ARN after deletion comes back as DELETE_COMPLETE;
  // treat it the same as never-deployed.
  if (!status || status === "DELETE_COMPLETE") return { kind: "not-deployed" };
  if (status.endsWith("_IN_PROGRESS")) return { kind: "in-progress", status };
  if (READY_STATUSES.has(status)) {
    return { kind: "ready", status, outputs: outputsToRecord(stack.Outputs) };
  }
  return { kind: "failed", status };
}

const describeStack: StackReader = async (region, credentials, stackName) => {
  const { CloudFormationClient, DescribeStacksCommand } =
    await import("@aws-sdk/client-cloudformation");
  const client = new CloudFormationClient({ credentials, region });
  try {
    const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
    return response.Stacks?.[0];
  } catch (error) {
    // Not-found is a thrown ValidationError, not an empty result. Every other
    // error (auth, throttling, malformed request) is real and propagates.
    if (isStackNotFound(error)) return undefined;
    throw error;
  } finally {
    client.destroy();
  }
};

/**
 * Reads a project's stack live from CloudFormation and classifies it.
 *
 * `read` is injectable for tests; production uses a real {@link DescribeStacksCommand}.
 * Accepts either a stack name or a stack ARN as `stackName`.
 */
export async function readStackState(
  region: string,
  credentials: CdkCredentialProvider,
  stackName: string,
  read: StackReader = describeStack,
): Promise<StackState> {
  return classifyStack(await read(region, credentials, stackName));
}
