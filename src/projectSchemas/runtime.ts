import {
  MAX_CONTAINER_BUILD_SECURITY_GROUPS,
  NetworkModeSchema,
  ProtocolModeSchema,
  RuntimeVersionSchema as RuntimeVersionSchemaFromConstants,
  SECURITY_GROUP_ID_PATTERN,
  SUBNET_ID_PATTERN,
  VPC_ID_PATTERN,
  isContainerBuild,
} from "./constants";
import type { DirectoryPath, FilePath } from "./types";
import { AuthorizerConfigSchema, RuntimeAuthorizerTypeSchema } from "./auth";
import { ConnectionSchema } from "./connections";
import { TagsSchema } from "./tags";
import { z } from "zod";
export const AgentNameSchema = z
  .string()
  .min(1, "Name is required")
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    "Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)",
  );
export const EnvVarNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    "Must start with a letter or underscore, contain only letters, digits, and underscores",
  );
export const GatewayNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(
    /^[0-9a-zA-Z](?:[0-9a-zA-Z-]*[0-9a-zA-Z])?$/,
    "Gateway name must be alphanumeric with optional hyphens (max 100 chars)",
  );
export const AccessSchema = z.enum(["read", "readwrite"]);
export type Access = z.infer<typeof AccessSchema>;
export const AgentTypeSchema = z.literal("AgentCoreRuntime");
export type AgentType = z.infer<typeof AgentTypeSchema>;
export const BuildTypeSchema = z.enum(["CodeZip", "Container"]);
export type BuildType = z.infer<typeof BuildTypeSchema>;
export const EntrypointSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-zA-Z0-9_][a-zA-Z0-9_/.-]*\.(py|ts|js)(:[a-zA-Z_][a-zA-Z0-9_]*)?$/,
    'Must be a Python (.py) or TypeScript (.ts/.js) file path with optional handler (e.g., "main.py:handler" or "index.ts")',
  ) as unknown as z.ZodType<FilePath>;
const DirectoryPathSchema = z.string().min(1) as unknown as z.ZodType<DirectoryPath>;
const DOCKERFILE_PATH_ALLOWED_CHARS = /^[A-Za-z0-9._/-]+$/;
export function isValidDockerfilePath(p: string): boolean {
  if (!DOCKERFILE_PATH_ALLOWED_CHARS.test(p)) return false;
  if (p.startsWith("/")) return false;
  return !p.split("/").some((segment) => segment === "" || segment === "..");
}
const DockerfilePathSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    isValidDockerfilePath,
    'Must be a relative path within the build context: a filename or forward-slash subpath using only letters, digits, dot, dash, underscore, and slash; no leading slash, no ".." traversal, and no empty segments (no trailing or double slash)',
  );
export const RESERVED_BUILD_ARG_KEYS = [
  "ECR_REGISTRY",
  "IMAGE_URI",
  "DOCKERFILE_PATH",
  "BUILD_ARG_FLAGS",
  "PATH",
  "HOME",
  "IFS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
];
export function isReservedBuildArgKey(key: string): boolean {
  return (
    RESERVED_BUILD_ARG_KEYS.includes(key) || key.startsWith("CODEBUILD_") || key.startsWith("AWS_")
  );
}
const BuildArgValueSchema = z
  .string()
  .max(4096, "Build arg values must be at most 4096 characters")
  .refine(
    (v) => ![...v].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f),
    "Build arg values must not contain control characters (including newlines)",
  );
export const EnvVarSchema = z.object({
  name: EnvVarNameSchema,
  value: z.string(),
});
export type EnvVar = z.infer<typeof EnvVarSchema>;
export const InstrumentationSchema = z.object({
  enableOtel: z.boolean().default(true),
});
export type Instrumentation = z.infer<typeof InstrumentationSchema>;
export const NetworkConfigSchema = z.object({
  subnets: z
    .array(z.string().regex(SUBNET_ID_PATTERN, "Must be a subnet id (subnet-...)"))
    .min(1)
    .max(16),
  securityGroups: z
    .array(z.string().regex(SECURITY_GROUP_ID_PATTERN, "Must be a security group id (sg-...)"))
    .min(1)
    .max(16),
  vpcId: z.string().regex(VPC_ID_PATTERN, "Must be a VPC id (vpc-...)").optional(),
});
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;
export const HEADER_ALLOWLIST_PREFIX = "X-Amzn-Bedrock-AgentCore-Runtime-Custom-";
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9\-_]+$/;
export const MAX_HEADER_ALLOWLIST_SIZE = 20;
export function checkAllowlistHeader(val: string): string | null {
  if (!HEADER_NAME_PATTERN.test(val)) {
    return `Header name "${val}" must contain only alphanumeric characters, hyphens, and underscores.`;
  }
  const lower = val.toLowerCase();
  if (lower.startsWith("x-amz-")) {
    return `Header "${val}" is not allowed. Headers starting with "x-amz-" are reserved for AWS request signing.`;
  }
  if (
    lower.startsWith("x-amzn-") &&
    !lower.startsWith("x-amzn-bedrock-agentcore-runtime-custom-")
  ) {
    return `Header "${val}" is not allowed. Headers starting with "x-amzn-" are reserved, except for "X-Amzn-Bedrock-AgentCore-Runtime-Custom-*".`;
  }
  return null;
}
export const RequestHeaderAllowlistSchema = z
  .array(
    z.string().superRefine((val, ctx) => {
      const error = checkAllowlistHeader(val);
      if (error) {
        ctx.addIssue({ code: "custom", message: error });
      }
    }),
  )
  .max(MAX_HEADER_ALLOWLIST_SIZE, `Maximum ${MAX_HEADER_ALLOWLIST_SIZE} headers allowed`);
export const SessionStorageSchema = z.object({
  mountPath: z
    .string()
    .min(6)
    .max(200)
    .regex(
      /^\/mnt\/[a-zA-Z0-9._-]+\/?$/,
      "Must be a path under /mnt with exactly one subdirectory (e.g. /mnt/data)",
    ),
});
export type SessionStorage = z.infer<typeof SessionStorageSchema>;
export const EFS_ACCESS_POINT_ARN_PATTERN =
  /^arn:aws[-a-z]*:elasticfilesystem:[a-z][a-z0-9-]*:[0-9]{12}:access-point\/fsap-[0-9a-f]{8,40}$/;
export const S3_FILES_ACCESS_POINT_ARN_PATTERN =
  /^arn:aws[-a-z]*:s3files:[a-z][a-z0-9-]*:[0-9]{12}:file-system\/fs-[0-9a-f]{17,40}\/access-point\/fsap-[0-9a-f]{17,40}$/;
export const EfsAccessPointConfigSchema = z.object({
  accessPointArn: z
    .string()
    .regex(
      EFS_ACCESS_POINT_ARN_PATTERN,
      "Must be an EFS access point ARN (arn:aws[-a-z]*:elasticfilesystem:{region}:{account}:access-point/fsap-{id})",
    ),
  mountPath: z
    .string()
    .min(6)
    .max(200)
    .regex(
      /^\/mnt\/[a-zA-Z0-9._-]+\/?$/,
      "Must be a path under /mnt with exactly one subdirectory (e.g. /mnt/tools)",
    ),
});
export type EfsAccessPointConfig = z.infer<typeof EfsAccessPointConfigSchema>;
export const S3FilesAccessPointConfigSchema = z.object({
  accessPointArn: z
    .string()
    .regex(
      S3_FILES_ACCESS_POINT_ARN_PATTERN,
      "Must be an S3 Files access point ARN (arn:aws[-a-z]*:s3files:{region}:{account}:file-system/fs-{id}/access-point/fsap-{id})",
    ),
  mountPath: z
    .string()
    .min(6)
    .max(200)
    .regex(
      /^\/mnt\/[a-zA-Z0-9._-]+\/?$/,
      "Must be a path under /mnt with exactly one subdirectory (e.g. /mnt/datasets)",
    ),
});
export type S3FilesAccessPointConfig = z.infer<typeof S3FilesAccessPointConfigSchema>;
export const MAX_EFS_MOUNTS = 2;
export const MAX_S3_MOUNTS = 2;
export const FilesystemConfigurationSchema = z.union([
  z.strictObject({ sessionStorage: SessionStorageSchema }),
  z.strictObject({ efsAccessPoint: EfsAccessPointConfigSchema }),
  z.strictObject({ s3FilesAccessPoint: S3FilesAccessPointConfigSchema }),
]);
export type FilesystemConfiguration = z.infer<typeof FilesystemConfigurationSchema>;
export const LIFECYCLE_TIMEOUT_MIN = 60;
export const LIFECYCLE_TIMEOUT_MAX = 28800;
export const LifecycleConfigurationSchema = z
  .object({
    idleRuntimeSessionTimeout: z
      .number()
      .int()
      .min(LIFECYCLE_TIMEOUT_MIN)
      .max(LIFECYCLE_TIMEOUT_MAX)
      .optional(),
    maxLifetime: z.number().int().min(LIFECYCLE_TIMEOUT_MIN).max(LIFECYCLE_TIMEOUT_MAX).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.idleRuntimeSessionTimeout !== undefined && data.maxLifetime !== undefined) {
      if (data.idleRuntimeSessionTimeout > data.maxLifetime) {
        ctx.addIssue({
          code: "custom",
          message: "idleRuntimeSessionTimeout must be <= maxLifetime",
          path: ["idleRuntimeSessionTimeout"],
        });
      }
    }
  });
export type LifecycleConfiguration = z.infer<typeof LifecycleConfigurationSchema>;
export const RuntimeEndpointNameSchema = z
  .string()
  .min(1, "Endpoint name is required")
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    "Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)",
  );
export const RuntimeEndpointSchema = z.object({
  version: z.number().int().min(1),
  description: z.string().max(200).optional(),
});
export type RuntimeEndpoint = z.infer<typeof RuntimeEndpointSchema>;
export const ProjectRuntimeSchema = z
  .object({
    name: AgentNameSchema,
    description: z.string().max(200).optional(),
    build: BuildTypeSchema,
    entrypoint: EntrypointSchema,
    codeLocation: DirectoryPathSchema,
    dockerfile: DockerfilePathSchema.optional(),
    buildContextPath: DirectoryPathSchema.optional(),
    customDockerBuildArgs: z.record(EnvVarNameSchema, BuildArgValueSchema).optional(),
    runtimeVersion: RuntimeVersionSchemaFromConstants.optional(),
    envVars: z.array(EnvVarSchema).optional(),
    networkMode: NetworkModeSchema.optional(),
    networkConfig: NetworkConfigSchema.optional(),
    instrumentation: InstrumentationSchema.optional(),
    protocol: ProtocolModeSchema.optional(),
    requestHeaderAllowlist: RequestHeaderAllowlistSchema.optional(),
    executionRoleArn: z.string().optional(),
    additionalPolicies: z.array(z.string().min(1)).optional(),
    authorizerType: RuntimeAuthorizerTypeSchema.optional(),
    authorizerConfiguration: AuthorizerConfigSchema.optional(),
    tags: TagsSchema.optional(),
    lifecycleConfiguration: LifecycleConfigurationSchema.optional(),
    filesystemConfigurations: z.array(FilesystemConfigurationSchema).optional(),
    endpoints: z.record(RuntimeEndpointNameSchema, RuntimeEndpointSchema).optional(),
    connections: z.array(ConnectionSchema).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.networkMode === "VPC" && !data.networkConfig) {
      ctx.addIssue({
        code: "custom",
        message: "networkConfig is required when networkMode is VPC",
        path: ["networkConfig"],
      });
    }
    if (data.networkMode !== "VPC" && data.networkConfig) {
      ctx.addIssue({
        code: "custom",
        message: "networkConfig is only allowed when networkMode is VPC",
        path: ["networkConfig"],
      });
    }
    if (
      data.networkMode === "VPC" &&
      isContainerBuild(data) &&
      data.networkConfig &&
      data.networkConfig.securityGroups.length > MAX_CONTAINER_BUILD_SECURITY_GROUPS
    ) {
      ctx.addIssue({
        code: "custom",
        message: `Container builds in VPC mode allow at most ${MAX_CONTAINER_BUILD_SECURITY_GROUPS} security groups (CodeBuild limit)`,
        path: ["networkConfig", "securityGroups"],
      });
    }
    if (
      data.authorizerType === "CUSTOM_JWT" &&
      !data.authorizerConfiguration?.customJwtAuthorizer
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "authorizerConfiguration with customJwtAuthorizer is required when authorizerType is CUSTOM_JWT",
        path: ["authorizerConfiguration"],
      });
    }
    if (data.authorizerType !== "CUSTOM_JWT" && data.authorizerConfiguration) {
      ctx.addIssue({
        code: "custom",
        message: "authorizerConfiguration is only allowed when authorizerType is CUSTOM_JWT",
        path: ["authorizerConfiguration"],
      });
    }
    for (const field of ["dockerfile", "buildContextPath", "customDockerBuildArgs"] as const) {
      if (data.build !== "Container" && data[field]) {
        ctx.addIssue({
          code: "custom",
          message: `${field} is only allowed for Container builds`,
          path: [field],
        });
      }
    }
    for (const key of Object.keys(data.customDockerBuildArgs ?? {})) {
      if (isReservedBuildArgKey(key)) {
        ctx.addIssue({
          code: "custom",
          message: `customDockerBuildArgs key "${key}" is reserved by the build environment (must not be ${RESERVED_BUILD_ARG_KEYS.join(", ")}, or start with CODEBUILD_ or AWS_)`,
          path: ["customDockerBuildArgs", key],
        });
      }
    }
    const fcs = data.filesystemConfigurations ?? [];
    if (fcs.length > 0) {
      const efsCount = fcs.filter((fc) => "efsAccessPoint" in fc).length;
      const s3Count = fcs.filter((fc) => "s3FilesAccessPoint" in fc).length;
      const ssCount = fcs.filter((fc) => "sessionStorage" in fc).length;
      if (fcs.length > 5) {
        ctx.addIssue({
          code: "custom",
          message: "Maximum 5 filesystem configurations allowed",
          path: ["filesystemConfigurations"],
        });
      }
      if (efsCount > MAX_EFS_MOUNTS) {
        ctx.addIssue({
          code: "custom",
          message: `Maximum ${MAX_EFS_MOUNTS} efsAccessPoint configurations allowed`,
          path: ["filesystemConfigurations"],
        });
      }
      if (s3Count > MAX_S3_MOUNTS) {
        ctx.addIssue({
          code: "custom",
          message: `Maximum ${MAX_S3_MOUNTS} s3FilesAccessPoint configurations allowed`,
          path: ["filesystemConfigurations"],
        });
      }
      if (ssCount > 1) {
        ctx.addIssue({
          code: "custom",
          message: "Maximum 1 sessionStorage configuration allowed",
          path: ["filesystemConfigurations"],
        });
      }
      const hasByo = efsCount > 0 || s3Count > 0;
      if (hasByo && data.networkMode !== "VPC") {
        ctx.addIssue({
          code: "custom",
          message:
            "efsAccessPoint and s3FilesAccessPoint filesystem mounts require networkMode: VPC",
          path: ["filesystemConfigurations"],
        });
      }
      const mountPaths = fcs.map((fc) =>
        ("sessionStorage" in fc
          ? fc.sessionStorage.mountPath
          : "efsAccessPoint" in fc
            ? fc.efsAccessPoint.mountPath
            : fc.s3FilesAccessPoint.mountPath
        ).replace(/\/$/, ""),
      );
      if (new Set(mountPaths).size !== mountPaths.length) {
        ctx.addIssue({
          code: "custom",
          message: "Filesystem mount paths must be unique",
          path: ["filesystemConfigurations"],
        });
      }
    }
  });
export type ProjectRuntime = z.infer<typeof ProjectRuntimeSchema>;
