import type { Stack } from "@aws-sdk/client-cloudformation";
import { MalformedServiceResponseError } from "../../../../errors/errors";
import { isStackNotFound } from "./environment";
import type { CdkCredentialProvider } from "./toolkit";

/**
 * Runs a `DescribeStacks` for one stack, returning the matched stacks (or
 * undefined). Injectable so callers/tests can supply the AWS call.
 */
export type DescribeStacks = (stackName: string) => Promise<Stack[] | undefined>;

// Real describer: lazily imports the SDK (kept off the CLI startup path, like
// environment.ts) and scopes a client to the target region + credentials.
function cloudFormationDescriber(
  region: string,
  credentials: CdkCredentialProvider,
): DescribeStacks {
  return async (stackName) => {
    const { CloudFormationClient, DescribeStacksCommand } =
      await import("@aws-sdk/client-cloudformation");
    const client = new CloudFormationClient({ credentials, region });
    try {
      const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
      return response.Stacks;
    } finally {
      client.destroy();
    }
  };
}

/**
 * Describes a project's CloudFormation stack, returning it or undefined when it
 * does not exist. Accepts a stack name or ARN.
 *
 * This is only the read: interpreting the stack's status and outputs (deployed
 * vs. in-progress vs. failed, which outputs to surface) is left to the caller —
 * e.g. `project status` — which owns that shape.
 */
export async function describeStack(
  region: string,
  credentials: CdkCredentialProvider,
  stackName: string,
  describe: DescribeStacks = cloudFormationDescriber(region, credentials),
): Promise<Stack | undefined> {
  let stacks: Stack[] | undefined;
  try {
    stacks = await describe(stackName);
  } catch (error) {
    // A missing stack is reported by a thrown ValidationError, not an empty
    // result, so this is the only "not deployed" signal. Every other error
    // (auth, throttling, malformed request) is real and propagates.
    if (isStackNotFound(error)) return undefined;
    throw error;
  }

  const stack = stacks?.[0];
  if (!stack) {
    // A *successful* DescribeStacks with no stack is malformed, not not-found;
    // returning undefined would misreport a service problem as "not deployed".
    throw new MalformedServiceResponseError(
      `CloudFormation returned no stack after describing '${stackName}'`,
    );
  }
  return stack;
}
