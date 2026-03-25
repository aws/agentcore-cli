/**
 * Agent Schema v2 - Clean, simplified model
 *
 * @module agent-env
 */
import {
  ModelProviderSchema,
  NetworkModeSchema,
  ProtocolModeSchema,
  RuntimeVersionSchema as RuntimeVersionSchemaFromConstants,
} from '../constants';
import type { DirectoryPath, FilePath } from '../types';
import { AuthorizerConfigSchema, RuntimeAuthorizerTypeSchema } from './auth';
import { TagsSchema } from './primitives/tags';
import { z } from 'zod';

// Re-export path types
export type { DirectoryPath, FilePath, PathType } from '../types';
export type { PythonRuntime, NodeRuntime, RuntimeVersion, NetworkMode, ProtocolMode } from '../constants';

// ============================================================================
// Name Schemas
// ============================================================================

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
  subnets: z
    .array(z.string().regex(/^subnet-[0-9a-zA-Z]{8,17}$/))
    .min(1)
    .max(16),
  securityGroups: z
    .array(z.string().regex(/^sg-[0-9a-zA-Z]{8,17}$/))
    .min(1)
    .max(16),
});
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;

/**
 * Allowed request headers for the runtime.
 * Each header must be 'Authorization' or start with 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-'.
 * Maximum 20 headers.
 */
export const HEADER_ALLOWLIST_PREFIX = 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-';
export const MAX_HEADER_ALLOWLIST_SIZE = 20;

export const RequestHeaderAllowlistSchema = z
  .array(
    z
      .string()
      .refine(
        val => val === 'Authorization' || val.startsWith(HEADER_ALLOWLIST_PREFIX),
        `Must be "Authorization" or start with "${HEADER_ALLOWLIST_PREFIX}"`
      )
  )
  .max(MAX_HEADER_ALLOWLIST_SIZE, `Maximum ${MAX_HEADER_ALLOWLIST_SIZE} headers allowed`);

/**
 * AgentEnvSpec - represents an AgentCore Runtime.
 * This is a top-level resource in the schema.
 */
export const AgentEnvSpecSchema = z
  .object({
    type: AgentTypeSchema,
    name: AgentNameSchema,
    build: BuildTypeSchema,
    entrypoint: EntrypointSchema,
    codeLocation: DirectoryPathSchema,
    runtimeVersion: RuntimeVersionSchemaFromConstants,
    /** Environment variables to set on the runtime */
    envVars: z.array(EnvVarSchema).optional(),
    /** Network mode for the runtime. Defaults to PUBLIC. */
    networkMode: NetworkModeSchema.optional(),
    /** Network configuration for VPC mode. Required when networkMode is 'VPC'. */
    networkConfig: NetworkConfigSchema.optional(),
    /** Instrumentation settings for observability. Defaults to OTel enabled. */
    instrumentation: InstrumentationSchema.optional(),
    /** Model provider used by this agent. Optional for backwards compatibility. */
    modelProvider: ModelProviderSchema.optional(),
    /** Protocol for the runtime (HTTP, MCP, A2A). */
    protocol: ProtocolModeSchema.optional(),
    /** Allowed request headers forwarded to the runtime at invocation time. */
    requestHeaderAllowlist: RequestHeaderAllowlistSchema.optional(),
    /** Authorizer type for inbound requests. Defaults to AWS_IAM. */
    authorizerType: RuntimeAuthorizerTypeSchema.optional(),
    /** Authorizer configuration. Required when authorizerType is CUSTOM_JWT. */
    authorizerConfiguration: AuthorizerConfigSchema.optional(),
    tags: TagsSchema.optional(),
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
  });

export type AgentEnvSpec = z.infer<typeof AgentEnvSpecSchema>;
