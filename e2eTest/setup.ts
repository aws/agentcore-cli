import {
  CloudFormationClient,
  DeleteStackCommand,
  ListStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { E2E_PREFIX } from "./constants";
import { createLogger } from "./helpers/logger";

const region = process.env.AWS_REGION ?? "us-east-1";
const stackPrefix = `AgentCore-${E2E_PREFIX}`;
const staleAgeMs = 2 * 60 * 60 * 1000;
const logger = createLogger("e2e-cleanup");

/** Given a CloudFormation client, deletes stale e2e stacks while preserving active stacks. */
export async function cleanupStaleStacks(cfn: CloudFormationClient): Promise<void> {
  let nextToken: string | undefined;

  do {
    const page = await cfn.send(new ListStacksCommand({ NextToken: nextToken }));
    nextToken = page.NextToken;

    for (const stack of page.StackSummaries ?? []) {
      const status = stack.StackStatus ?? "";
      const age = Date.now() - (stack.CreationTime?.getTime() ?? Date.now());

      if (
        stack.ParentId ||
        !stack.StackName?.startsWith(stackPrefix) ||
        status === "DELETE_COMPLETE" ||
        status.endsWith("_IN_PROGRESS") ||
        age < staleAgeMs
      ) {
        continue;
      }

      try {
        logger.info(`deleting stale stack '${stack.StackName}' (${status})`);
        await cfn.send(new DeleteStackCommand({ StackName: stack.StackName }));
      } catch (error) {
        logger.warn(
          `failed to delete stale stack '${stack.StackName}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        // Leave failed cleanup for a later pre-run sweep.
      }
    }
  } while (nextToken);
}

logger.info(`starting cleanup in ${region} for stacks prefixed with '${stackPrefix}'`);
try {
  await cleanupStaleStacks(new CloudFormationClient({ region }));
} catch (error) {
  logger.error(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  throw error;
}
