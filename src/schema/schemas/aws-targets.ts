import { uniqueBy } from './zod-util';
import { z } from 'zod';

// ============================================================================
// AgentCore Regions
// ============================================================================

export const AgentCoreRegionSchema = z.enum([
  'ap-northeast-1',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'eu-central-1',
  'eu-west-1',
  'us-east-1',
  'us-east-2',
  'us-west-2',
]);
export type AgentCoreRegion = z.infer<typeof AgentCoreRegionSchema>;

// ============================================================================
// Deployment Target Name
// ============================================================================

export const DeploymentTargetNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_-]*$/,
    'Name must start with a letter and contain only alphanumeric characters, hyphens, and underscores'
  )
  .describe('Unique identifier for the deployment target');

// ============================================================================
// AWS Account ID
// ============================================================================

export const AwsAccountIdSchema = z
  .string()
  .regex(/^[0-9]{12}$/, 'AWS account ID must be exactly 12 digits')
  .describe('AWS account ID');

// ============================================================================
// AWS Deployment Target
// ============================================================================

export const AwsDeploymentTargetSchema = z.object({
  name: DeploymentTargetNameSchema,
  description: z.string().max(256).optional(),
  account: AwsAccountIdSchema,
  region: AgentCoreRegionSchema,
});

export type AwsDeploymentTarget = z.infer<typeof AwsDeploymentTargetSchema>;

// ============================================================================
// AWS Deployment Targets Array
// ============================================================================

export const AwsDeploymentTargetsSchema = z.array(AwsDeploymentTargetSchema).superRefine(
  uniqueBy(
    target => target.name,
    name => `Duplicate deployment target name: ${name}`
  )
);

export type AwsDeploymentTargets = z.infer<typeof AwsDeploymentTargetsSchema>;
