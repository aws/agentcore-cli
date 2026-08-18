import z from "zod";

/**
 * Mirrors AwsDeploymentTarget in @aws/agentcore-cdk: each entry names the account and
 * region the CDK app synthesizes a stack for. `agentcore project create` scaffolds an
 * empty list, so a project has no targets until the user fills them in.
 */
export const AwsTargetsSchema = z.array(
  z.object({
    name: z.string(),
    // Checked here because a deploy turns this straight into `aws://<account>/<region>`: a
    // typo fails while reading the file, alongside the example of a valid one the reader
    // prints, rather than minutes later from inside the CDK toolkit.
    account: z.string().regex(/^\d{12}$/, "must be a 12-digit AWS account ID"),
    region: z.string(),
  }),
);

export type AwsTarget = z.infer<typeof AwsTargetsSchema>[number];
