import {
  DescribeStacksCommand,
  GetStackPolicyCommand,
  GetTemplateCommand,
  type CloudFormationClient,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import type { MigrationCheck } from "../../../handlers/project/migrate/types";
import { isStackNotFound } from "../backends/cdk/environment";
import type { CfnTemplate } from "./templates";

/**
 * Reading the deployed stack (status, template, stack policy) is all planning
 * needs from AWS, and it's read-only, so a preview never changes the account.
 */
/** The CloudFormation reads migration planning makes; all read-only. */
export type StackReader = {
  /** The stack, or undefined when it doesn't exist. */
  describe(stackName: string): Promise<Stack | undefined>;
  /** The stack policy document, or undefined when the stack has none. */
  stackPolicy(stackName: string): Promise<string | undefined>;
  /** The template the stack was last deployed with, exactly as submitted. */
  template(stackName: string): Promise<CfnTemplate>;
};

/** Reads stacks through one CloudFormation client. */
export function cloudFormationStackReader(client: CloudFormationClient): StackReader {
  return {
    async describe(stackName) {
      try {
        const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
        return response.Stacks?.[0];
      } catch (error) {
        if (isStackNotFound(error)) return undefined;
        throw error;
      }
    },
    async stackPolicy(stackName) {
      const response = await client.send(new GetStackPolicyCommand({ StackName: stackName }));
      return response.StackPolicyBody?.trim() ? response.StackPolicyBody : undefined;
    },
    async template(stackName) {
      // "Original" is the template as deployed, before transforms; it's what a
      // stack refactor's templates are compared against.
      const response = await client.send(
        new GetTemplateCommand({ StackName: stackName, TemplateStage: "Original" }),
      );
      const body = response.TemplateBody;
      if (!body) throw new Error(`CloudFormation returned no template for stack '${stackName}'.`);
      let template: unknown;
      try {
        template = JSON.parse(body);
      } catch {
        throw new Error(
          `Stack '${stackName}' was deployed with a template that isn't JSON. The CDK always ` +
            "deploys JSON, so the stack was last updated outside the AgentCore CLI; redeploy it " +
            "with `agentcore deploy`, then try again.",
        );
      }
      return template as CfnTemplate;
    },
  };
}

/**
 * The states a stack can be refactored from. A stack still changing can't be
 * refactored, and one whose last operation failed or rolled back (including
 * UPDATE_ROLLBACK_COMPLETE, whose resources are back at the previous template
 * while the project files describe the failed one) may not match the project, so
 * both stop the migration until a v0 deploy succeeds.
 */
const STABLE_STATUSES = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"]);

/**
 * A deployed target's stack must exist, be in a stable state, and have no stack
 * policy (CloudFormation's stack refactoring rejects any stack that has one).
 */
export async function checkStack(
  reader: StackReader,
  target: string,
  stackName: string,
): Promise<MigrationCheck> {
  const name = `stack (${target})`;
  const fail = (message: string) => ({ name, ok: false, message });
  const stack = await reader.describe(stackName);
  if (!stack) {
    return fail(
      `The deployed state records stack '${stackName}' for target '${target}', but it doesn't ` +
        "exist. Redeploy the target with `agentcore deploy`, or remove the target " +
        "from agentcore/.cli/deployed-state.json if it was deleted on purpose.",
    );
  }
  const status = stack.StackStatus ?? "UNKNOWN";
  if (!STABLE_STATUSES.has(status)) {
    const advice = status.endsWith("_IN_PROGRESS")
      ? "Wait for the operation in progress to finish, then try again."
      : "Run `agentcore deploy` until it succeeds, then try again.";
    return fail(
      `Stack '${stackName}' is ${status}; it must be ${[...STABLE_STATUSES].join(", ")}. ${advice}`,
    );
  }
  if ((await reader.stackPolicy(stackName)) !== undefined) {
    return fail(
      `Stack '${stackName}' has a stack policy, and CloudFormation stack refactoring doesn't ` +
        "support stacks with a stack policy (whatever it allows). Migration needs a refactor to " +
        "keep the deployed resources, so it can't migrate this stack.",
    );
  }
  return { name, ok: true, message: `${stackName} is ${status}, with no stack policy` };
}
