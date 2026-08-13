import z from "zod";

/**
 * Mirrors AwsDeploymentTarget in @aws/agentcore-cdk: each entry names the account and
 * region the CDK app synthesizes a stack for. `agentcore project create` scaffolds an
 * empty list, so a project has no targets until the user fills them in.
 */
export const AwsTargetsSchema = z.array(
  z.object({ name: z.string(), account: z.string(), region: z.string() }),
);

export type AwsTarget = z.infer<typeof AwsTargetsSchema>[number];
