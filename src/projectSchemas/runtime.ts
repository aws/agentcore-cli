import {
  ContainerUriSchema,
  MAX_CONTAINER_BUILD_SECURITY_GROUPS,
  NetworkModeSchema,
  type PlatformVersion,
  PlatformVersionSchema,
  ProtocolModeSchema,
  RuntimeVersionSchema as RuntimeVersionSchemaFromConstants,
  SECURITY_GROUP_ID_PATTERN,
  SUBNET_ID_PATTERN,
  VPC_ID_PATTERN,
} from "./constants";
import type { DirectoryPath } from "./types";
import { AuthorizerConfigSchema, RuntimeAuthorizerTypeSchema } from "./auth";
import { ConnectionSchema } from "./connections";
import { TagsSchema } from "./tags";
import { uniqueBy } from "./zod-util";
import { z } from "zod";
export const AgentNameSchema = z
  .string()
  .min(1, "Name is required")
  .max(48, "Must be at most 48 characters")
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
export const BuildTypeSchema = z.enum(["CodeZip", "Container", "ContainerLocal"]);
export type BuildType = z.infer<typeof BuildTypeSchema>;
export const EntrypointSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-zA-Z0-9_][a-zA-Z0-9_/.-]*\.(py|ts|js)(:[a-zA-Z_][a-zA-Z0-9_]*)?$/,
    'Must be a Python (.py) or TypeScript (.ts/.js) file path with optional handler (e.g., "main.py:handler" or "index.ts")',
  );
const DirectoryPathSchema = z.string().min(1) as unknown as z.ZodType<DirectoryPath>;
const DOCKERFILE_PATH_ALLOWED_CHARS = /^[A-Za-z0-9._/-]+$/;
export function isValidDockerfilePath(p: string): boolean {
  if (!DOCKERFILE_PATH_ALLOWED_CHARS.test(p)) return false;
  if (p.startsWith("/")) return false;
  return !p.split("/").some((segment) => segment === "" || segment === "..");
}
export const DockerfilePathSchema = z
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
// Only the shape is checked here; the CDK app and the service check the bucket and prefix rules.
// Strict so a misspelled optional key, such as s3BucketOwner, fails instead of being dropped.
export const S3BucketMountConfigSchema = z.strictObject({
  /** General purpose or directory bucket name. */
  bucket: z.string().min(3).max(63),
  mountPath: z
    .string()
    .min(6)
    .max(200)
    .regex(
      /^\/mnt\/[a-zA-Z0-9._-]+\/?$/,
      "Must be a path under /mnt with exactly one subdirectory (e.g. /mnt/bucket)",
    ),
  /**
   * Key prefix to mount; the whole bucket when omitted. {runtimeSessionId} gives each session
   * its own prefix (e.g. "data/{runtimeSessionId}/").
   */
  prefix: z.string().min(1).max(1024).optional(),
  /** Account that must own the bucket; defaults to the runtime's account. */
  s3BucketOwner: z
    .string()
    .regex(/^[0-9]{12}$/, "Must be a 12-digit AWS account ID")
    .optional(),
  /** Region of the bucket; defaults to the runtime's Region. */
  s3BucketRegion: z
    .string()
    .min(1)
    .max(32)
    .regex(/^([a-z]+-){2,3}\d+$/, "Must be an AWS Region code (e.g. us-west-2)")
    .optional(),
});
export type S3BucketMountConfig = z.infer<typeof S3BucketMountConfigSchema>;
export const MAX_EFS_MOUNTS = 2;
export const MAX_S3_MOUNTS = 2;
export const FilesystemConfigurationSchema = z.union([
  z.strictObject({ sessionStorage: SessionStorageSchema }),
  z.strictObject({ efsAccessPoint: EfsAccessPointConfigSchema }),
  z.strictObject({ s3FilesAccessPoint: S3FilesAccessPointConfigSchema }),
  z.strictObject({ s3BucketMount: S3BucketMountConfigSchema }),
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

// Shape only, and loose: the service validates sizes, paths, ports and the V2 requirement, and
// fields it adds later pass through to it without a CLI release.
export const ResourceConfigurationSchema = z.looseObject({
  minimumMemoryInMiB: z.number().int().positive(),
});
export type ResourceConfiguration = z.infer<typeof ResourceConfigurationSchema>;

export const LifecycleHookSchema = z.looseObject({
  action: z.looseObject({
    httpPost: z.looseObject({
      path: z.string().min(1),
      port: z.number().int().optional(),
    }),
  }),
});
export type LifecycleHook = z.infer<typeof LifecycleHookSchema>;

export const RuntimeHooksConfigurationSchema = z.looseObject({
  build: z.looseObject({ warmup: LifecycleHookSchema.optional() }).optional(),
});
export type RuntimeHooksConfiguration = z.infer<typeof RuntimeHooksConfigurationSchema>;
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
export const MODEL_PROVIDERS = [
  "Bedrock",
  "Anthropic",
  "OpenAI",
  "OpenAICompatible",
  "Gemini",
  "LiteLLM",
] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/**
 * OpenAICompatible is the OpenAI client pointed at a user-supplied base URL
 * (DeepSeek, Qwen, a self-hosted vLLM, ...). Nothing can be assumed about the
 * endpoint, so it has no default model id: the user names the model.
 */
export type ModelProviderWithDefaultModelId = Exclude<ModelProvider, "OpenAICompatible">;

/** The model id each provider's scaffolded code renders when none is given:
 * the flag path's default and the wizards' prefilled answer, so the entry
 * points cannot drift. */
export const DEFAULT_MODEL_IDS: Record<ModelProviderWithDefaultModelId, string> = {
  Bedrock: "global.anthropic.claude-sonnet-5-5",
  Anthropic: "claude-sonnet-5-5",
  OpenAI: "gpt-6.1-sol",
  Gemini: "gemini-3.8-flash",
  LiteLLM: "bedrock/global.anthropic.claude-sonnet-5-5",
};

const MODEL_PROVIDER_ALIASES: Record<string, ModelProvider> = {
  bedrock: "Bedrock",
  anthropic: "Anthropic",
  openai: "OpenAI",
  open_ai: "OpenAI",
  openai_compatible: "OpenAICompatible",
  "openai-compatible": "OpenAICompatible",
  openaicompatible: "OpenAICompatible",
  gemini: "Gemini",
  litellm: "LiteLLM",
  lite_llm: "LiteLLM",
};

/** Parses a provider name case-insensitively (e.g. `anthropic`), normalizing to canonical casing. */
export const ModelProviderSchema = z.preprocess(
  (value) =>
    typeof value === "string" ? (MODEL_PROVIDER_ALIASES[value.toLowerCase()] ?? value) : value,
  z.enum(MODEL_PROVIDERS),
);

/** A box release version, as the tag `v<version>` of the box release names it. */
export const BoxVersionSchema = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/, "a box version is letters, digits, '.', '+' and '-'");

/**
 * How far a runtime of a Box project is contained. `CONTAINED`, or no field: the agent runs in a box
 * behind its Box gateway. `PRIVATE_VPC`: also in a private VPC with no internet path.
 */
export const ContainmentSchema = z.enum(["CONTAINED", "PRIVATE_VPC"]);
export type Containment = z.infer<typeof ContainmentSchema>;
export const PRIVATE_VPC_LIMIT =
  'A project can have only one runtime with "containment": "PRIVATE_VPC". Create a new project for each PRIVATE_VPC runtime.';

/** The platform a runtime of a Box project needs: Box runs only on AgentCore Runtime V2. */
export const BOX_PLATFORM_VERSION: PlatformVersion = "V2";

function isVpcCidr(value: string): boolean {
  const [address = "", prefix = "", ...rest] = value.split("/");
  const octets = address.split(".");
  if (rest.length > 0 || !/^\d{2}$/.test(prefix) || octets.length !== 4) return false;
  if (!octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255))
    return false;
  const bits = Number(prefix);
  const ip = octets.reduce((total, octet) => total * 256 + Number(octet), 0);
  return bits >= 16 && bits <= 24 && ip % 2 ** (32 - bits) === 0;
}
/** Everything else about a PRIVATE_VPC runtime's VPC is set in CDK through `AgentCoreApplication.network(runtimeName)`. */
export const ContainedNetworkSchema = z
  .object({
    mode: z.enum(["CONTAINED"]).optional(),
    cidr: z
      .string()
      .refine(
        isVpcCidr,
        "Must be an aligned IPv4 CIDR block with a /16 to /24 prefix, such as 10.0.0.0/16",
      )
      .optional(),
    availabilityZoneIds: z
      .array(
        z
          .string()
          .regex(
            /^[a-z]{3,6}\d{1,2}-az\d{1,2}$/,
            "Must be an Availability Zone ID, such as usw2-az1",
          ),
      )
      .min(2)
      .max(3)
      .superRefine(
        uniqueBy(
          (id) => id,
          (id) => `Duplicate Availability Zone ID: ${id}`,
        ),
      )
      .optional(),
    ipAddressType: z.enum(["IPV4", "DUAL_STACK"]).optional(),
    /**
     * Gives the VPC an AWS Secrets Manager endpoint, so the box of the runtime can read the keys of
     * its third-party telemetry targets. Build sets it and removes it.
     */
    secretsManagerEndpoint: z.boolean().optional(),
  })
  .strict();
export type ContainedNetwork = z.infer<typeof ContainedNetworkSchema>;
/**
 * The rules for a pre-built image (`containerUri`): it is the whole container
 * artifact, so it needs `build: "Container"` and excludes every local build
 * setting. Shared by agentcore.json and `add runtime --build-config`. The CDK
 * package's Runtime schema applies the same cross-field rules, and its
 * ContainerUriSchema enforces the same image URI grammar as ContainerUriSchema
 * in constants.ts (tag, digest, repository length, whitespace, total length);
 * keep the two in sync.
 */
export function containerUriIssues(data: {
  containerUri?: string;
  build?: string;
  dockerfile?: unknown;
  buildContextPath?: unknown;
  customDockerBuildArgs?: unknown;
}): { message: string; path: string[] }[] {
  if (data.containerUri === undefined) return [];
  const issues: { message: string; path: string[] }[] = [];
  // Messages and paths match @aws/agentcore-cdk's AgentEnvSpecSchema. An omitted
  // build (add runtime --build-config) defaults to Container.
  if (data.build !== undefined && data.build !== "Container") {
    issues.push({
      message:
        "containerUri requires build 'Container' (it cannot be used with CodeZip or ContainerLocal)",
      path: ["containerUri"],
    });
  }
  for (const field of ["dockerfile", "buildContextPath", "customDockerBuildArgs"] as const) {
    if (data[field] !== undefined) {
      issues.push({ message: `${field} cannot be used with containerUri`, path: [field] });
    }
  }
  return issues;
}

export const ProjectRuntimeSchema = z
  .object({
    name: AgentNameSchema,
    /**
     * The model provider a template scaffold wired into this runtime's code.
     * Written by scaffolds whose template renders provider client code; absent
     * for BYO/provider-free runtimes and projects from older CLI versions.
     * Read by the China (aws-cn) deploy gate; ignored by the CDK app.
     * If you replace the model wiring in the runtime's code by hand, delete
     * this field to reflect that.
     */
    modelProvider: ModelProviderSchema.optional(),
    /**
     * The model id the scaffold rendered into the runtime's code (explicit
     * --model-id or the template default), for a LiteLLM runtime and for a
     * box runtime that calls a Bedrock model. The China deploy gate reads it
     * to detect LiteLLM's Bedrock route ('bedrock/' prefix). For a box runtime,
     * build lets its Box gateway call only this Bedrock model or inference
     * profile; change it when the code calls another model. Ignored by the CDK
     * app. Delete it together with modelProvider if you replace the model
     * wiring by hand.
     */
    modelId: z.string().min(1).optional(),
    description: z.string().max(200).optional(),
    build: BuildTypeSchema,
    entrypoint: EntrypointSchema,
    codeLocation: DirectoryPathSchema,
    /**
     * An existing private or public ECR image to deploy, with `build: "Container"`.
     * Deployment then skips local source, the Dockerfile, CodeBuild, and the
     * CDK-managed ECR repository.
     */
    containerUri: ContainerUriSchema.optional(),
    dockerfile: DockerfilePathSchema.optional(),
    buildContextPath: DirectoryPathSchema.optional(),
    customDockerBuildArgs: z.record(EnvVarNameSchema, BuildArgValueSchema).optional(),
    runtimeVersion: RuntimeVersionSchemaFromConstants.optional(),
    /**
     * The box release a runtime that runs its agent in a box uses on AgentCore Runtime: build and
     * deploy ship its Linux build in a CodeZip runtime's zip, and a container image downloads it
     * (under `agentcore dev` too). `agentcore dev` runs a CodeZip agent with the `box` on your PATH
     * instead. Every runtime of a Box project needs it, and only a runtime with it runs in a box;
     * `agentcore create` writes the box release this CLI pins.
     */
    box: z.object({ version: BoxVersionSchema }).optional(),
    /**
     * Removing this keeps a deployed runtime on its current version; set V1 to move back. Every
     * runtime of a Box project needs `"V2"`; create writes it.
     */
    platformVersion: PlatformVersionSchema.optional(),
    envVars: z.array(EnvVarSchema).optional(),
    networkMode: NetworkModeSchema.optional(),
    networkConfig: NetworkConfigSchema.optional(),
    instrumentation: InstrumentationSchema.optional(),
    protocol: ProtocolModeSchema.optional(),
    requestHeaderAllowlist: RequestHeaderAllowlistSchema.optional(),
    executionRoleArn: z.string().optional(),
    additionalPolicies: z.array(z.string().min(1)).optional(),
    /** Enables the CDK-managed Bedrock Managed Agents session role for this runtime. */
    bedrockManagedAgents: z.boolean().optional(),
    authorizerType: RuntimeAuthorizerTypeSchema.optional(),
    authorizerConfiguration: AuthorizerConfigSchema.optional(),
    tags: TagsSchema.optional(),
    lifecycleConfiguration: LifecycleConfigurationSchema.optional(),
    /** Each update replaces this, so removing it returns sessions to consumption-based pricing. */
    resourceConfigurations: z.array(ResourceConfigurationSchema).optional(),
    /** Each update replaces this, so removing it removes the hooks. */
    hooksConfiguration: RuntimeHooksConfigurationSchema.optional(),
    filesystemConfigurations: z.array(FilesystemConfigurationSchema).optional(),
    endpoints: z.record(RuntimeEndpointNameSchema, RuntimeEndpointSchema).optional(),
    connections: z.array(ConnectionSchema).optional(),
    containment: ContainmentSchema.optional(),
    /** Only with `"containment": "PRIVATE_VPC"`. */
    network: ContainedNetworkSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.network && data.containment !== "PRIVATE_VPC") {
      ctx.addIssue({
        code: "custom",
        message: '"network" is only allowed with "containment": "PRIVATE_VPC"',
        path: ["network"],
      });
    }
    if (
      data.containment === "PRIVATE_VPC" &&
      (data.networkMode !== undefined || data.networkConfig !== undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          '"containment": "PRIVATE_VPC" puts the runtime in its own private VPC, so leave networkMode and networkConfig unset',
        path: ["containment"],
      });
    }
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
    // Only a Runtime CodeBuild builds has the CodeBuild VPC limits; a pre-built image does not.
    const codeBuildContainer = data.build === "Container" && data.containerUri === undefined;
    if (
      data.networkMode === "VPC" &&
      codeBuildContainer &&
      data.networkConfig &&
      data.networkConfig.securityGroups.length > MAX_CONTAINER_BUILD_SECURITY_GROUPS
    ) {
      ctx.addIssue({
        code: "custom",
        message: `Container builds in VPC mode allow at most ${MAX_CONTAINER_BUILD_SECURITY_GROUPS} security groups (CodeBuild limit)`,
        path: ["networkConfig", "securityGroups"],
      });
    }
    // Mirrors the CDK, which feeds networkConfig.vpcId to the CodeBuild project's
    // VpcConfig. Only `build: "Container"` reaches that path, so CodeZip is exempt.
    if (data.networkMode === "VPC" && codeBuildContainer && !data.networkConfig?.vpcId) {
      ctx.addIssue({
        code: "custom",
        message:
          "networkConfig.vpcId is required for Container builds in VPC mode (CodeBuild cannot infer the VPC from subnets)",
        path: ["networkConfig", "vpcId"],
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
    // Mirrors the CDK construct library, which rejects a CodeZip runtime with no
    // runtimeVersion: it is the field that selects the packager. Validating it here
    // means the CLI reports it against agentcore.json instead of letting synthesis
    // fail later with the same rule.
    if (data.build === "CodeZip" && !data.runtimeVersion) {
      ctx.addIssue({
        code: "custom",
        message: "runtimeVersion is required for CodeZip builds",
        path: ["runtimeVersion"],
      });
    }
    for (const field of ["dockerfile", "buildContextPath", "customDockerBuildArgs"] as const) {
      if (data.build === "CodeZip" && data[field]) {
        ctx.addIssue({
          code: "custom",
          message: `${field} is only allowed for Container builds`,
          path: [field],
        });
      }
    }
    for (const issue of containerUriIssues(data)) ctx.addIssue({ code: "custom", ...issue });
    // Reserved by the CodeBuild build environment; ContainerLocal builds locally.
    // Keep in step with the @aws/agentcore-cdk schema.
    for (const key of Object.keys(data.customDockerBuildArgs ?? {})) {
      if (data.build !== "ContainerLocal" && isReservedBuildArgKey(key)) {
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
            : "s3FilesAccessPoint" in fc
              ? fc.s3FilesAccessPoint.mountPath
              : fc.s3BucketMount.mountPath
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
