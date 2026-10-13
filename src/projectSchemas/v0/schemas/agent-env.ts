/**
 * Agent Schema v2 - Clean, simplified model
 *
 * @module agent-env
 */
import {
  MAX_CONTAINER_BUILD_SECURITY_GROUPS,
  NetworkModeSchema,
  ProtocolModeSchema,
  RuntimeVersionSchema as RuntimeVersionSchemaFromConstants,
  SECURITY_GROUP_ID_PATTERN,
  SUBNET_ID_PATTERN,
  VPC_ID_PATTERN,
  isContainerBuild,
} from '../constants';
import type { DirectoryPath, FilePath } from '../types';
import { AuthorizerConfigSchema, RuntimeAuthorizerTypeSchema } from './auth';
import { ConnectionSchema } from './connections';
import { CapacityProviderConfigurationSchema, CapacityProviderVolumeNameSchema } from './primitives/capacity-provider';
import { TagsSchema } from './primitives/tags';
import { z } from 'zod';

// Re-export path types
export type { DirectoryPath, FilePath, PathType } from '../types';
export type { PythonRuntime, NodeRuntime, RuntimeVersion, NetworkMode, ProtocolMode } from '../constants';

// ============================================================================
// Name Schemas
// ============================================================================

// https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateAgentRuntime.html
export const AgentNameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

export const EnvVarNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'Must start with a letter or underscore, contain only letters, digits, and underscores'
  );

// https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateGateway.html
export const GatewayNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    // eslint-disable-next-line security/detect-unsafe-regex -- input bounded to 100 chars by .max(100) above
    /^[0-9a-zA-Z](?:[0-9a-zA-Z-]*[0-9a-zA-Z])?$/,
    'Gateway name must be alphanumeric with optional hyphens (max 100 chars)'
  );

// ============================================================================
// Common Types
// ============================================================================

/** Access level for resource sharing */
export const AccessSchema = z.enum(['read', 'readwrite']);
export type Access = z.infer<typeof AccessSchema>;

// ============================================================================
// Agent Schema
// ============================================================================

export const AgentTypeSchema = z.literal('AgentCoreRuntime');
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const BuildTypeSchema = z.enum(['CodeZip', 'Container']);
export type BuildType = z.infer<typeof BuildTypeSchema>;

// Use RuntimeVersionSchema from constants (supports both Python and Node/TypeScript)
// Not re-exported here to avoid duplicate export conflicts

/**
 * Entrypoint schema - supports both Python (.py) and TypeScript (.ts/.js) files.
 * Python: main.py or main.py:handler
 * TypeScript: main.ts, main.js, or index.ts
 */
export const EntrypointSchema = z
  .string()
  .min(1)
  .regex(
    // eslint-disable-next-line security/detect-unsafe-regex -- character class quantifiers don't cause backtracking
    /^[a-zA-Z0-9_][a-zA-Z0-9_/.-]*\.(py|ts|js)(:[a-zA-Z_][a-zA-Z0-9_]*)?$/,
    'Must be a Python (.py) or TypeScript (.ts/.js) file path with optional handler (e.g., "main.py:handler" or "index.ts")'
  ) as unknown as z.ZodType<FilePath>;

const DirectoryPathSchema = z.string().min(1) as unknown as z.ZodType<DirectoryPath>;

// Char-safe set only (no backslash, spaces, or shell metacharacters): on deploy the buildspec
// interpolates this unquoted as `docker build -f $DOCKERFILE_PATH`. A leading '.' is allowed so
// conventional paths like '.docker/Dockerfile' pass.
const DOCKERFILE_PATH_ALLOWED_CHARS = /^[A-Za-z0-9._/-]+$/;

/**
 * True when `p` is a safe relative Dockerfile path within the build context: allowed chars only, no
 * leading slash (absolute), and no empty ('' from a leading/trailing/double slash) or '..' segments.
 *
 * The single source of truth shared by `DockerfilePathSchema` (config-validation time) and the runtime
 * `getDockerfilePath` guard, so the two can never diverge — e.g. one accepting '.docker/Dockerfile'
 * while the other rejects it, or one accepting a trailing-slash directory value like 'docker/'.
 */
export function isValidDockerfilePath(p: string): boolean {
  if (!DOCKERFILE_PATH_ALLOWED_CHARS.test(p)) return false;
  if (p.startsWith('/')) return false;
  return !p.split('/').some(segment => segment === '' || segment === '..');
}

/**
 * Dockerfile location for Container builds, resolved relative to the Docker build context
 * (`buildContextPath` when set, otherwise `codeLocation`). Accepts a filename ('Dockerfile',
 * 'Dockerfile.gpu') or a forward-slash relative subpath ('docker/Dockerfile'). Absolute paths,
 * trailing/double slashes, and '..' traversal are rejected so the Dockerfile can never escape or
 * name the build context directory itself.
 */
const DockerfilePathSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    isValidDockerfilePath,
    'Must be a relative path within the build context: a filename or forward-slash subpath using only letters, digits, dot, dash, underscore, and slash; no leading slash, no ".." traversal, and no empty segments (no trailing or double slash)'
  );

/**
 * Build-arg names reserved by the CodeBuild build environment. On deploy each build arg becomes a
 * CodeBuild environment-variable override alongside the buildspec's own control vars, so a colliding
 * name would break the deploy build — a wrong image tag / ECR region, a rejected StartBuild, or a
 * clobbered build-container shell. We reject the buildspec control vars, the process-critical shell
 * vars, and CodeBuild's own `AWS_*` / `CODEBUILD_*` namespaces. This is a best-effort denylist (the
 * shell has other sensitive vars), but it covers the realistic footguns and keeps a config that
 * builds locally from failing only on deploy.
 */
export const RESERVED_BUILD_ARG_KEYS = [
  // Buildspec control vars (mirrored in @aws/agentcore-cdk's ContainerBuildProject / build handler).
  'ECR_REGISTRY',
  'IMAGE_URI',
  'DOCKERFILE_PATH',
  'BUILD_ARG_FLAGS',
  // Overriding these in the build shell would break the buildspec's own commands (command lookup,
  // word-splitting, dynamic linking) or redirect the docker client off the build daemon. Kept
  // deliberately narrow to the genuinely-dangerous names so common ARGs (e.g. USER, LANG) stay usable.
  'PATH',
  'HOME',
  'IFS',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DOCKER_HOST',
  'DOCKER_CONFIG',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
];

export function isReservedBuildArgKey(key: string): boolean {
  return RESERVED_BUILD_ARG_KEYS.includes(key) || key.startsWith('CODEBUILD_') || key.startsWith('AWS_');
}

/**
 * Build-arg value. Bounded and control-char-free because on deploy each value becomes a CodeBuild
 * `environmentVariablesOverride` PLAINTEXT entry; newlines/control chars or an over-long value can be
 * rejected by StartBuild, so we reject them at schema time rather than let a local-only-valid config
 * fail on deploy.
 */
const BuildArgValueSchema = z
  .string()
  .max(4096, 'Build arg values must be at most 4096 characters')
  .refine(
    v => ![...v].some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f),
    'Build arg values must not contain control characters (including newlines)'
  );

export const EnvVarSchema = z.object({
  name: EnvVarNameSchema,
  value: z.string(),
});
export type EnvVar = z.infer<typeof EnvVarSchema>;

/**
 * Instrumentation configuration for runtime observability.
 */
export const InstrumentationSchema = z.object({
  /**
   * Enable OpenTelemetry instrumentation using aws-opentelemetry-distro.
   * When enabled, the runtime entrypoint is wrapped with opentelemetry-instrument.
   * Defaults to true for new runtimes.
   */
  enableOtel: z.boolean().default(true),
});
export type Instrumentation = z.infer<typeof InstrumentationSchema>;

/**
 * Network configuration for VPC mode.
 * Required when networkMode is 'VPC'.
 */
export const NetworkConfigSchema = z.object({
  subnets: z.array(z.string().regex(SUBNET_ID_PATTERN, 'Must be a subnet id (subnet-...)')).min(1).max(16),
  securityGroups: z
    .array(z.string().regex(SECURITY_GROUP_ID_PATTERN, 'Must be a security group id (sg-...)'))
    .min(1)
    .max(16),
  /**
   * VPC ID. Required for Container builds in VPC mode because CodeBuild needs an explicit VPC ID;
   * it cannot infer the VPC from subnets alone. Runtime/Lambda builds can omit this.
   */
  vpcId: z.string().regex(VPC_ID_PATTERN, 'Must be a VPC id (vpc-...)').optional(),
});
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;

/**
 * Allowed request headers for the runtime.
 * Per https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-header-allowlist.html
 * any valid HTTP header name (alphanumeric, hyphens, underscores) may be allow-listed,
 * provided it is not structurally reserved (x-amz-*, x-amzn-* except Runtime-Custom-*).
 * Maximum 20 headers.
 */
export const HEADER_ALLOWLIST_PREFIX = 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-';
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9\-_]+$/;
export const MAX_HEADER_ALLOWLIST_SIZE = 20;

/**
 * Validate a single allowlist header name. Returns null if valid, or a specific
 * error message describing which rule the input violated.
 *
 * Note: 'x-amz-' and 'x-amzn-' are disjoint prefixes (position 5 differs: '-' vs 'n'),
 * so the two checks below are independent.
 */
export function checkAllowlistHeader(val: string): string | null {
  if (!HEADER_NAME_PATTERN.test(val)) {
    return `Header name "${val}" must contain only alphanumeric characters, hyphens, and underscores.`;
  }
  const lower = val.toLowerCase();
  if (lower.startsWith('x-amz-')) {
    return `Header "${val}" is not allowed. Headers starting with "x-amz-" are reserved for AWS request signing.`;
  }
  if (lower.startsWith('x-amzn-') && !lower.startsWith('x-amzn-bedrock-agentcore-runtime-custom-')) {
    return `Header "${val}" is not allowed. Headers starting with "x-amzn-" are reserved, except for "X-Amzn-Bedrock-AgentCore-Runtime-Custom-*".`;
  }
  return null;
}

export const RequestHeaderAllowlistSchema = z
  .array(
    z.string().superRefine((val, ctx) => {
      const error = checkAllowlistHeader(val);
      if (error) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
      }
    })
  )
  .max(MAX_HEADER_ALLOWLIST_SIZE, `Maximum ${MAX_HEADER_ALLOWLIST_SIZE} headers allowed`);

/**
 * Session storage configuration for filesystem persistence.
 * Files written to mountPath persist across session stop/resume cycles.
 */
export const SessionStorageSchema = z.object({
  /** Absolute mount path under /mnt with exactly one subdirectory level (e.g. /mnt/data). */
  mountPath: z
    .string()
    .min(6)
    .max(200)
    .regex(/^\/mnt\/[a-zA-Z0-9._-]+\/?$/, 'Must be a path under /mnt with exactly one subdirectory (e.g. /mnt/data)'),
});
export type SessionStorage = z.infer<typeof SessionStorageSchema>;

export const EFS_ACCESS_POINT_ARN_PATTERN =
  /^arn:aws[-a-z]*:elasticfilesystem:[a-z][a-z0-9-]*:[0-9]{12}:access-point\/fsap-[0-9a-f]{8,40}$/;

export const S3_FILES_ACCESS_POINT_ARN_PATTERN =
  /^arn:aws[-a-z]*:s3files:[a-z][a-z0-9-]*:[0-9]{12}:file-system\/fs-[0-9a-f]{17,40}\/access-point\/fsap-[0-9a-f]{17,40}$/;

/** EFS access point mount configuration. Requires VPC network mode. */
export const EfsAccessPointConfigSchema = z.object({
  /** ARN of an EFS access point. */
  accessPointArn: z
    .string()
    .regex(
      EFS_ACCESS_POINT_ARN_PATTERN,
      'Must be an EFS access point ARN (arn:aws[-a-z]*:elasticfilesystem:{region}:{account}:access-point/fsap-{id})'
    ),
  /** Absolute mount path under /mnt (e.g. /mnt/tools). */
  mountPath: z
    .string()
    .min(6)
    .max(200)
    .regex(/^\/mnt\/[a-zA-Z0-9._-]+\/?$/, 'Must be a path under /mnt with exactly one subdirectory (e.g. /mnt/tools)'),
});
export type EfsAccessPointConfig = z.infer<typeof EfsAccessPointConfigSchema>;

/** S3 Files access point mount configuration. Requires VPC network mode. */
export const S3FilesAccessPointConfigSchema = z.object({
  /** ARN of an S3 Files access point. */
  accessPointArn: z
    .string()
    .regex(
      S3_FILES_ACCESS_POINT_ARN_PATTERN,
      'Must be an S3 Files access point ARN (arn:aws[-a-z]*:s3files:{region}:{account}:file-system/fs-{id}/access-point/fsap-{id})'
    ),
  /** Absolute mount path under /mnt (e.g. /mnt/datasets). */
  mountPath: z
    .string()
    .min(6)
    .max(200)
    .regex(
      /^\/mnt\/[a-zA-Z0-9._-]+\/?$/,
      'Must be a path under /mnt with exactly one subdirectory (e.g. /mnt/datasets)'
    ),
});
export type S3FilesAccessPointConfig = z.infer<typeof S3FilesAccessPointConfigSchema>;

/** Capacity provider volume mount — references a named volume on the attached CP. */
export const CapacityProviderVolumeConfigSchema = z.object({
  /** Logical name of a volume defined on the attached capacity provider (CP's volumes[]). */
  volumeName: CapacityProviderVolumeNameSchema,
  /** Absolute mount path under /mnt (e.g. /mnt/models). */
  mountPath: z
    .string()
    .min(6)
    .max(200)
    .regex(/^\/mnt\/[a-zA-Z0-9._-]+\/?$/, 'Must be a path under /mnt with exactly one subdirectory (e.g. /mnt/models)'),
});
export type CapacityProviderVolumeConfig = z.infer<typeof CapacityProviderVolumeConfigSchema>;

/** Maximum number of EFS access point mounts per runtime. */
export const MAX_EFS_MOUNTS = 2;
/** Maximum number of S3 Files access point mounts per runtime. */
export const MAX_S3_MOUNTS = 2;

/**
 * Filesystem configuration — union of four mount types.
 * Exactly one key must be present per entry.
 *
 * Service limits per runtime: max 5 total, max 1 sessionStorage,
 * max MAX_EFS_MOUNTS efsAccessPoint, max MAX_S3_MOUNTS s3FilesAccessPoint.
 * efsAccessPoint and s3FilesAccessPoint require networkMode: VPC.
 * capacityProviderVolume requires the runtime to be attached to a capacity provider.
 */
export const FilesystemConfigurationSchema = z.union([
  z.strictObject({ sessionStorage: SessionStorageSchema }),
  z.strictObject({ efsAccessPoint: EfsAccessPointConfigSchema }),
  z.strictObject({ s3FilesAccessPoint: S3FilesAccessPointConfigSchema }),
  z.strictObject({ capacityProviderVolume: CapacityProviderVolumeConfigSchema }),
]);
export type FilesystemConfiguration = z.infer<typeof FilesystemConfigurationSchema>;

/** Minimum allowed value for lifecycle timeout fields (seconds). */
export const LIFECYCLE_TIMEOUT_MIN = 60;
/** Maximum allowed value for lifecycle timeout fields (seconds). */
export const LIFECYCLE_TIMEOUT_MAX = 28800;

/**
 * Lifecycle configuration for runtime sessions.
 * Controls idle timeout and max lifetime of runtime instances.
 */
export const LifecycleConfigurationSchema = z
  .object({
    /** Idle session timeout in seconds. API default: 900s. */
    idleRuntimeSessionTimeout: z.number().int().min(LIFECYCLE_TIMEOUT_MIN).max(LIFECYCLE_TIMEOUT_MAX).optional(),
    /** Max instance lifetime in seconds. API default: 28800s. */
    maxLifetime: z.number().int().min(LIFECYCLE_TIMEOUT_MIN).max(LIFECYCLE_TIMEOUT_MAX).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.idleRuntimeSessionTimeout !== undefined && data.maxLifetime !== undefined) {
      if (data.idleRuntimeSessionTimeout > data.maxLifetime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'idleRuntimeSessionTimeout must be <= maxLifetime',
          path: ['idleRuntimeSessionTimeout'],
        });
      }
    }
  });
export type LifecycleConfiguration = z.infer<typeof LifecycleConfigurationSchema>;

// ============================================================================
// Runtime Endpoint Schema
// ============================================================================

/**
 * Endpoint name follows the AgentCore API regex for endpoint aliases.
 */
export const RuntimeEndpointNameSchema = z
  .string()
  .min(1, 'Endpoint name is required')
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

export const RuntimeEndpointSchema = z.object({
  /** Version number this endpoint points to. Must be >= 1. */
  version: z.number().int().min(1),
  /** Optional human-readable description of this endpoint. */
  description: z.string().max(200).optional(),
});

export type RuntimeEndpoint = z.infer<typeof RuntimeEndpointSchema>;

/**
 * AgentEnvSpec - represents an AgentCore Runtime.
 * This is a top-level resource in the schema.
 */
export const AgentEnvSpecSchema = z
  .object({
    name: AgentNameSchema,
    /** Optional description for the runtime. */
    description: z.string().max(200).optional(),
    build: BuildTypeSchema,
    entrypoint: EntrypointSchema,
    codeLocation: DirectoryPathSchema,
    /**
     * Dockerfile for Container builds, resolved relative to the build context (`buildContextPath`
     * when set, otherwise `codeLocation`). A filename or a relative subpath; no traversal. Default: 'Dockerfile'.
     */
    dockerfile: DockerfilePathSchema.optional(),
    /**
     * Docker build context directory for Container builds. When set, this directory (instead of
     * `codeLocation`) is used as the `docker build` context and as the root the Dockerfile path is
     * resolved against, so a single Dockerfile can be shared across multiple agents in a monorepo
     * (e.g. so it can COPY files that live outside `codeLocation`). Container builds only.
     *
     * Like `codeLocation`, this is intentionally not containment-checked: the config author may point
     * it at any directory (including a parent via `..` for a monorepo root). The unconditional
     * secret-exclusion baseline on the deploy upload still applies to whatever directory is chosen.
     */
    buildContextPath: DirectoryPathSchema.optional(),
    /**
     * Custom build arguments passed to `docker build` as `--build-arg` flags. Keys must be valid
     * environment-variable names (each arg is forwarded to the build as an env var), reusing
     * `EnvVarNameSchema`. Useful for parameterising a shared Dockerfile per agent
     * (e.g. `{ "AGENT_NAME": "myagent" }`). Container builds only.
     */
    customDockerBuildArgs: z.record(EnvVarNameSchema, BuildArgValueSchema).optional(),
    runtimeVersion: RuntimeVersionSchemaFromConstants.optional(),
    /** Environment variables to set on the runtime */
    envVars: z.array(EnvVarSchema).optional(),
    /** Network mode for the runtime. Defaults to PUBLIC. */
    networkMode: NetworkModeSchema.optional(),
    /** Network configuration for VPC mode. Required when networkMode is 'VPC'. */
    networkConfig: NetworkConfigSchema.optional(),
    /** Instrumentation settings for observability. Defaults to OTel enabled. */
    instrumentation: InstrumentationSchema.optional(),
    /** Protocol for the runtime (HTTP, MCP, A2A, AGUI). */
    protocol: ProtocolModeSchema.optional(),
    /** Allowed request headers forwarded to the runtime at invocation time. */
    requestHeaderAllowlist: RequestHeaderAllowlistSchema.optional(),
    /** ARN of an existing IAM execution role to use instead of creating a new one. */
    executionRoleArn: z.string().optional(),
    /**
     * Additional IAM policies attached to the runtime execution role. Each entry is either a
     * managed-policy ARN (attached directly) or a `.json` policy-document file path relative to
     * `codeLocation` (attached as an inline policy). For opaque AWS access (e.g. S3) the CLI does
     * not model as a typed connection.
     */
    additionalPolicies: z.array(z.string().min(1)).optional(),
    /** Authorizer type for inbound requests. Defaults to AWS_IAM. */
    authorizerType: RuntimeAuthorizerTypeSchema.optional(),
    /** Authorizer configuration. Required when authorizerType is CUSTOM_JWT. */
    authorizerConfiguration: AuthorizerConfigSchema.optional(),
    tags: TagsSchema.optional(),
    /** Lifecycle configuration for runtime sessions. */
    lifecycleConfiguration: LifecycleConfigurationSchema.optional(),
    /** Filesystem configurations for session-scoped persistent storage. */
    filesystemConfigurations: z.array(FilesystemConfigurationSchema).optional(),
    /** Named endpoints (version aliases) for this runtime. Keys are endpoint names. */
    endpoints: z.record(RuntimeEndpointNameSchema, RuntimeEndpointSchema).optional(),
    /** Connections to external AgentCore resources (memory/gateway/runtime). The construct
     *  generates IAM + discovery env vars onto this runtime's execution role. */
    connections: z.array(ConnectionSchema).optional(),
    /** Attach the runtime to a capacity provider (customer-managed EC2 compute) — either an
     *  in-project sibling by name or an external CP by ARN. Mutually exclusive with VPC networking:
     *  in CP mode the network topology comes from the capacity provider. */
    capacityProviderConfiguration: CapacityProviderConfigurationSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.networkMode === 'VPC' && !data.networkConfig) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'networkConfig is required when networkMode is VPC',
        path: ['networkConfig'],
      });
    }
    if (data.networkMode !== 'VPC' && data.networkConfig) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'networkConfig is only allowed when networkMode is VPC',
        path: ['networkConfig'],
      });
    }
    // Capacity-provider mode supplies its own network topology, so networkMode is not a settable
    // property on a CP-attached runtime — neither VPC nor PUBLIC. The service derives networking
    // from the capacity provider, so any explicit networkMode (or networkConfig) is rejected.
    if (data.capacityProviderConfiguration && (data.networkMode !== undefined || data.networkConfig)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'capacityProviderConfiguration cannot be combined with a networkMode or VPC networking — a capacity provider supplies its own network topology, so leave networkMode/networkConfig unset',
        path: ['capacityProviderConfiguration'],
      });
    }
    // NOTE: vpcId is NOT required here at the schema (read/write) level. A Container+VPC agent needs
    // a vpcId to build (CodeBuild can't infer it), but enforcing that on read would hard-fail
    // pre-existing agentcore.json files written before vpcId existed. Instead: the CLI input
    // validators require --vpc-id for fresh Container+VPC creates, deploy backfills a missing vpcId
    // from the subnets (ec2:DescribeSubnets) and persists it, and the CDK construct fails fast if it
    // is still missing at synth. This keeps `status`/`remove`/`validate` working on old configs.
    if (
      data.networkMode === 'VPC' &&
      isContainerBuild(data) &&
      data.networkConfig &&
      data.networkConfig.securityGroups.length > MAX_CONTAINER_BUILD_SECURITY_GROUPS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Container builds in VPC mode allow at most ${MAX_CONTAINER_BUILD_SECURITY_GROUPS} security groups (CodeBuild limit)`,
        path: ['networkConfig', 'securityGroups'],
      });
    }
    if (data.authorizerType === 'CUSTOM_JWT' && !data.authorizerConfiguration?.customJwtAuthorizer) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'authorizerConfiguration with customJwtAuthorizer is required when authorizerType is CUSTOM_JWT',
        path: ['authorizerConfiguration'],
      });
    }
    if (data.authorizerType !== 'CUSTOM_JWT' && data.authorizerConfiguration) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'authorizerConfiguration is only allowed when authorizerType is CUSTOM_JWT',
        path: ['authorizerConfiguration'],
      });
    }
    // Container-only fields. If adding more, extend this list (and consider consolidating into a
    // containerConfig object — see the networkConfig pattern).
    for (const field of ['dockerfile', 'buildContextPath', 'customDockerBuildArgs'] as const) {
      if (data.build !== 'Container' && data[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${field} is only allowed for Container builds`,
          path: [field],
        });
      }
    }
    for (const key of Object.keys(data.customDockerBuildArgs ?? {})) {
      if (isReservedBuildArgKey(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `customDockerBuildArgs key "${key}" is reserved by the build environment (must not be ${RESERVED_BUILD_ARG_KEYS.join(', ')}, or start with CODEBUILD_ or AWS_)`,
          path: ['customDockerBuildArgs', key],
        });
      }
    }
    const fcs = data.filesystemConfigurations ?? [];
    if (fcs.length > 0) {
      const efsCount = fcs.filter(fc => 'efsAccessPoint' in fc).length;
      const s3Count = fcs.filter(fc => 's3FilesAccessPoint' in fc).length;
      const ssCount = fcs.filter(fc => 'sessionStorage' in fc).length;
      const cpVolCount = fcs.filter(fc => 'capacityProviderVolume' in fc).length;

      // A capacity-provider volume can only be mounted when the runtime is attached to a
      // capacity provider — the volume is defined on that CP's volumes[].
      if (cpVolCount > 0 && !data.capacityProviderConfiguration) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'capacityProviderVolume filesystem mounts require the runtime to be attached to a capacity provider (set capacityProviderConfiguration)',
          path: ['filesystemConfigurations'],
        });
      }

      if (fcs.length > 5) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Maximum 5 filesystem configurations allowed',
          path: ['filesystemConfigurations'],
        });
      }
      if (efsCount > MAX_EFS_MOUNTS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Maximum ${MAX_EFS_MOUNTS} efsAccessPoint configurations allowed`,
          path: ['filesystemConfigurations'],
        });
      }
      if (s3Count > MAX_S3_MOUNTS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Maximum ${MAX_S3_MOUNTS} s3FilesAccessPoint configurations allowed`,
          path: ['filesystemConfigurations'],
        });
      }
      if (ssCount > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Maximum 1 sessionStorage configuration allowed',
          path: ['filesystemConfigurations'],
        });
      }

      const hasByo = efsCount > 0 || s3Count > 0;
      if (hasByo && data.networkMode !== 'VPC') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'efsAccessPoint and s3FilesAccessPoint filesystem mounts require networkMode: VPC',
          path: ['filesystemConfigurations'],
        });
      }

      const mountPaths = fcs.map(fc =>
        ('sessionStorage' in fc
          ? fc.sessionStorage.mountPath
          : 'efsAccessPoint' in fc
            ? fc.efsAccessPoint.mountPath
            : 's3FilesAccessPoint' in fc
              ? fc.s3FilesAccessPoint.mountPath
              : fc.capacityProviderVolume.mountPath
        ).replace(/\/$/, '')
      );
      if (new Set(mountPaths).size !== mountPaths.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Filesystem mount paths must be unique',
          path: ['filesystemConfigurations'],
        });
      }
    }
  });

export type AgentEnvSpec = z.infer<typeof AgentEnvSpecSchema>;
