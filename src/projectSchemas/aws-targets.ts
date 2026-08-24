import { z } from "zod";
import { uniqueBy } from "./zod-util";

// Keep in sync with https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html
export const AgentCoreRegionSchema = z.enum([
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-5",
  "ap-southeast-7",
  "ca-central-1",
  "eu-central-1",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "sa-east-1",
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "us-gov-west-1",
]);

export const DeploymentTargetNameSchema = z
  .string()
  .min(1)
  .max(64)
  // Underscores are rejected up front even though the CDK normalizes them to
  // hyphens, so a target name means the same thing everywhere it appears.
  .regex(
    /^[a-zA-Z][a-zA-Z0-9-]*$/,
    "Name must start with a letter and contain only alphanumeric characters and hyphens",
  )
  .describe("Unique identifier for the deployment target");

export const AwsAccountIdSchema = z
  .string()
  .regex(/^[0-9]{12}$/, "AWS account ID must be exactly 12 digits")
  .describe("AWS account ID");

export const AwsDeploymentTargetSchema = z.object({
  name: DeploymentTargetNameSchema,
  description: z.string().max(256).optional(),
  account: AwsAccountIdSchema,
  region: AgentCoreRegionSchema,
});

export type AwsDeploymentTarget = z.infer<typeof AwsDeploymentTargetSchema>;

export const AwsDeploymentTargetsSchema = z.array(AwsDeploymentTargetSchema).superRefine(
  uniqueBy<AwsDeploymentTarget>(
    (target) => target.name,
    (name) => `Duplicate deployment target name: ${name}`,
  ),
);

export type AwsDeploymentTargets = z.infer<typeof AwsDeploymentTargetsSchema>;
