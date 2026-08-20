import { z } from "zod";
import { uniqueBy } from "./zod-util";

export const AgentCoreRegionSchema = z.enum([
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ca-central-1",
  "eu-central-1",
  "eu-north-1",
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
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_-]*$/,
    "Name must start with a letter and contain only alphanumeric characters, hyphens, and underscores",
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
