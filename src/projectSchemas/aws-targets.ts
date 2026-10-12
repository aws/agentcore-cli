import { z } from "zod";
import { uniqueBy } from "./zod-util";

// Keep in sync with https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html
// and with the library copy at agentcore-l3-cdk-constructs/src/schema/schemas/aws-targets.ts.
export const AgentCoreRegionSchema = z.enum([
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-south-1",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-5",
  "ap-southeast-7",
  "ca-central-1",
  "cn-north-1",
  "cn-northwest-1",
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
  "us-west-1",
  "us-west-2",
  "us-gov-west-1",
]);

/**
 * The target `agentcore deploy` uses when --target is omitted. Only this target
 * is ever synthesized from the environment when aws-targets.json lacks it;
 * named targets must be defined explicitly so a typo cannot invent one.
 */
export const DEFAULT_TARGET_NAME = "default";

export const DeploymentTargetNameSchema = z
  .string()
  .min(1)
  .max(64)
  /**
   The v0 CLI's rule, so v0 targets such as `prod-us` keep working. The target is the middle segment of deployed resource names (`<project><sep><target><sep><name>`). Where the separator is `_` because the service disallows `-` (Runtime, Memory, Harness, ...), the CDK library writes the target's hyphens as underscores; `-` and `/` separated names (Gateway, ECR, Lambda, ...) and the `AgentCore-<project>-<target>` stack name keep them.
  **/
  .regex(
    /^[a-zA-Z][a-zA-Z0-9-]*$/,
    "Name must start with a letter and contain only letters, digits, and hyphens",
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
    (target) => target.name.toLowerCase(),
    (name) => `Duplicate deployment target name (ignoring case): ${name}`,
  ),
);

export type AwsDeploymentTargets = z.infer<typeof AwsDeploymentTargetsSchema>;
