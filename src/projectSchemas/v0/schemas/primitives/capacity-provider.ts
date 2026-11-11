import { TagsSchema } from './tags';
import { z } from 'zod';

// ============================================================================
// Capacity Provider Types
//
// Models the AWS::BedrockAgentCore::CapacityProvider CFN resource. Known fields
// are typed and validated here so bad input is rejected at `add` time instead
// of failing late at deploy/CFN time; the long tail of launch parameters is
// accepted via `.passthrough()` and validated by CFN on deploy.
//
// NOTE: This schema is duplicated in @aws/agentcore-cdk
// (src/schema/schemas/primitives/capacity-provider.ts). Keep the two in sync.
// ============================================================================

/**
 * Capacity provider name validation.
 * Pattern: ^[a-zA-Z][a-zA-Z0-9_]{0,47}$ (matches the CFN Name property).
 */
export const CapacityProviderNameSchema = z
  .string()
  .min(1, 'Capacity provider name is required')
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

// ============================================================================
// Operator Role ARN Validation
// ============================================================================

/**
 * Pattern for the capacity provider operator role ARN, matching the CFN
 * resource contract exactly. The account segment is OPTIONAL — the service
 * accepts role ARNs without an account id, so we must not force 12 digits.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- anchored ARN pattern, no backtracking risk
export const CAPACITY_PROVIDER_OPERATOR_ROLE_ARN_PATTERN = /^arn:[^:]+:iam::([0-9]{12})?:role\/.+$/;

export const OperatorRoleArnSchema = z
  .string()
  .min(1, 'Operator role ARN is required')
  .max(2048)
  .regex(
    CAPACITY_PROVIDER_OPERATOR_ROLE_ARN_PATTERN,
    'Must be a valid IAM role ARN (e.g. arn:<partition>:iam::123456789012:role/MyOperatorRole)'
  );

export function isValidOperatorRoleArn(value: string): boolean {
  return CAPACITY_PROVIDER_OPERATOR_ROLE_ARN_PATTERN.test(value);
}

// ============================================================================
// Capacity Provider Attach (runtime -> capacity provider reference)
//
// A runtime attaches to a capacity provider via `capacityProviderConfiguration`.
// The reference is EITHER an in-project sibling (by name) OR an external CP (by
// ARN) — exactly one. At synth the CDK app resolves a sibling name to the created
// CP's ARN, or passes the ARN through, then injects
// CapacityProviderConfiguration.CapacityProviderArn onto the CfnRuntime.
//
// NOTE: This block is duplicated in @aws/agentcore-cdk. Keep the two in sync.
// ============================================================================

/**
 * Partition-agnostic capacity-provider ARN (arn:[^:]+: per multi-partition rules). The resource
 * segment is the service capacityProviderId — `{name}-{10 alnum}` — not a free-form string, so a
 * malformed external ARN is rejected at `add`/validate time instead of only failing at deploy.
 * Keep the id shape in sync with CAPACITY_PROVIDER_ID_PATTERN (cli/commands/capacity-provider/constants).
 */
export const CAPACITY_PROVIDER_ARN_PATTERN =
  /^arn:[^:]+:bedrock-agentcore:[a-z0-9-]+:\d{12}:capacity-provider\/[a-zA-Z][a-zA-Z0-9_]{0,47}-[a-zA-Z0-9]{10}$/;

export const CapacityProviderArnSchema = z
  .string()
  .regex(
    CAPACITY_PROVIDER_ARN_PATTERN,
    'Must be a valid bedrock-agentcore capacity provider ARN (…:capacity-provider/{name}-{10 alphanumerics})'
  );

/**
 * Route a `--capacity-provider <name-or-arn>` value: an `arn:` prefix means an
 * external CP referenced by ARN, otherwise it is an in-project sibling name.
 */
export function isCapacityProviderArn(value: string): boolean {
  return value.startsWith('arn:');
}

/**
 * Logical name of a capacity-provider volume, referenced by a runtime's
 * `capacityProviderVolume` filesystem mount. Must match the name of a volume
 * defined on the capacity provider (EbsVolumeConfiguration.name).
 */
export const CapacityProviderVolumeNameSchema = z
  .string()
  .min(1, 'Capacity provider volume name is required')
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/,
    'Volume name must begin with a letter and contain only alphanumerics, underscores, and hyphens (max 48 chars)'
  );

/**
 * Runtime -> capacity-provider reference. Exactly one of `capacityProviderArn`
 * (external CP) or `capacityProviderName` (in-project sibling) must be set.
 */
export const CapacityProviderConfigurationSchema = z
  .strictObject({
    /** ARN of an external capacity provider (not defined in this project). */
    capacityProviderArn: CapacityProviderArnSchema.optional(),
    /** Name of an in-project capacity provider (a `capacityProviders[]` sibling). */
    capacityProviderName: CapacityProviderNameSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if ((data.capacityProviderArn !== undefined) === (data.capacityProviderName !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'capacityProviderConfiguration must set exactly one of capacityProviderArn or capacityProviderName',
      });
    }
  });
export type CapacityProviderConfiguration = z.infer<typeof CapacityProviderConfigurationSchema>;

// ============================================================================
// Operating System
//
// The CFN resource enum lists four values (LINUX_X86_64, LINUX_ARM64,
// MAC_ARM64, WINDOWS_X86_64), but the service API contract only supports the
// two Linux values today; the extra two leaked into the CFN autogen ahead of
// real support. The CLI follows the API and exposes only the Linux values.
// ============================================================================

export const OperatingSystemSchema = z.enum(['LINUX_X86_64', 'LINUX_ARM64']);
export type OperatingSystem = z.infer<typeof OperatingSystemSchema>;

// ============================================================================
// VPC Configuration
// ============================================================================

export const VpcConfigurationSchema = z.object({
  subnets: z
    .array(z.string().regex(/^subnet-[0-9a-zA-Z]{8,17}$/, 'Must be a valid subnet ID'))
    .min(1, 'At least one subnet is required')
    .max(16),
  securityGroups: z
    .array(z.string().regex(/^sg-[0-9a-zA-Z]{8,17}$/, 'Must be a valid security group ID'))
    .min(1, 'At least one security group is required')
    .max(16),
});

export type VpcConfiguration = z.infer<typeof VpcConfigurationSchema>;

// ============================================================================
// Instance Requirements
// ============================================================================

export const InstanceRequirementsSchema = z.object({
  allowedInstanceTypes: z.array(z.string().min(1).max(255)).min(1, 'At least one instance type is required').max(30),
});

export type InstanceRequirements = z.infer<typeof InstanceRequirementsSchema>;

// ============================================================================
// Launch Parameters
//
// Known fields are typed; the long tail (sshKeyName, monitoring,
// licenseSpecifications, capacityReservationSpecification, ephemeralVolumes,
// propagatedTags) is accepted via `.passthrough()` and validated by CFN.
// ============================================================================

export const LaunchParametersSchema = z
  .object({
    operatingSystem: OperatingSystemSchema,
    instanceRequirements: InstanceRequirementsSchema,
    instanceProfileArn: z
      .string()
      .regex(/^arn:[^:]+:iam::[0-9]{12}:instance-profile\/.+$/, 'Must be a valid IAM instance profile ARN')
      .optional(),
  })
  .passthrough();

export type LaunchParameters = z.infer<typeof LaunchParametersSchema>;

// ============================================================================
// EBS Volume Configuration
//
// Known fields typed; EBS long-tail tuning (iops, throughput, snapshotId) is
// accepted via `.passthrough()`.
// ============================================================================

export const EbsVolumeConfigurationSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(48)
      .regex(
        /^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/,
        'Volume name must begin with a letter and contain only alphanumerics, underscores, and hyphens (max 48 chars)'
      ),
    sizeGiB: z.number().int().min(1).max(65536),
    volumeType: z.enum(['standard', 'io1', 'io2', 'gp2', 'sc1', 'st1', 'gp3']).optional(),
    encrypted: z.boolean().optional(),
    kmsKeyId: z
      .string()
      .regex(
        /^arn:[^:]+:kms:[a-z0-9-]+:[0-9]{12}:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
        'Must be a valid KMS key ARN'
      )
      .optional(),
  })
  .passthrough();

export type EbsVolumeConfiguration = z.infer<typeof EbsVolumeConfigurationSchema>;

export const VolumeConfigurationSchema = z.object({
  ebsConfiguration: EbsVolumeConfigurationSchema,
});

export type VolumeConfiguration = z.infer<typeof VolumeConfigurationSchema>;

// ============================================================================
// Instance Lifecycle Configuration
// ============================================================================

const LIFECYCLE_SECONDS_MIN = 60;
const LIFECYCLE_SECONDS_MAX = 1209600;

export const InstanceLifecycleConfigurationSchema = z.object({
  idleInstanceTimeout: z.number().int().min(LIFECYCLE_SECONDS_MIN).max(LIFECYCLE_SECONDS_MAX).optional(),
  maxLifetime: z.number().int().min(LIFECYCLE_SECONDS_MIN).max(LIFECYCLE_SECONDS_MAX).optional(),
});

export type InstanceLifecycleConfiguration = z.infer<typeof InstanceLifecycleConfigurationSchema>;

// ============================================================================
// Compute Configuration
//
// `rootVolume` is accepted via `.passthrough()` on ec2Configuration (long-tail,
// service-managed).
// ============================================================================

export const Ec2ConfigurationSchema = z
  .object({
    launchTemplateSource: z.object({
      launchParameters: LaunchParametersSchema,
    }),
    vpcConfiguration: VpcConfigurationSchema,
    volumes: z.array(VolumeConfigurationSchema).max(5).optional(),
    lifecycleConfiguration: InstanceLifecycleConfigurationSchema.optional(),
  })
  .passthrough();

export type Ec2Configuration = z.infer<typeof Ec2ConfigurationSchema>;

export const ComputeConfigurationSchema = z.object({
  ec2Configuration: Ec2ConfigurationSchema,
});

export type ComputeConfiguration = z.infer<typeof ComputeConfigurationSchema>;

// ============================================================================
// Capacity Provider Schema
// ============================================================================

export const CapacityProviderSchema = z.object({
  /** Capacity provider name (immutable after creation). */
  name: CapacityProviderNameSchema,
  /** Optional description (max 4096 chars). The only mutable field besides tags. */
  description: z.string().min(1).max(4096).optional(),
  /**
   * ARN of the IAM role AgentCore assumes to manage the capacity provider (immutable). Optional:
   * when omitted, an operator role with the required trust policy and managed permissions is
   * created automatically at deploy time.
   */
  operatorRoleArn: OperatorRoleArnSchema.optional(),
  /** Compute resources for the capacity provider (immutable after creation). */
  computeConfiguration: ComputeConfigurationSchema,
  /** Optional resource tags. */
  tags: TagsSchema.optional(),
});

export type CapacityProvider = z.infer<typeof CapacityProviderSchema>;
