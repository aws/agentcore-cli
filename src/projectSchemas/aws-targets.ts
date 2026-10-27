import { z } from "zod";
import { uniqueBy } from "./zod-util";

// Accepts any region: AgentCore availability changes faster than CLI releases, so a
// region without AgentCore is left for CloudFormation to reject at deploy time.
export const AgentCoreRegionSchema = z.string();

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
