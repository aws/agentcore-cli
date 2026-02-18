/**
 * Agent Schema v2 - Clean, simplified model
 *
 * @module agent-env
 */
import {
  ModelProviderSchema,
  NetworkModeSchema,
  RuntimeVersionSchema as RuntimeVersionSchemaFromConstants,
} from '../constants';
import type { DirectoryPath, FilePath } from '../types';
import { z } from 'zod';

// Re-export path types
export type { DirectoryPath, FilePath, PathType } from '../types';
export type { PythonRuntime, NodeRuntime, RuntimeVersion, NetworkMode } from '../constants';

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
 * AgentEnvSpec - represents an AgentCore Runtime.
 * This is a top-level resource in the schema.
 */
export const AgentEnvSpecSchema = z.object({
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
  /** Instrumentation settings for observability. Defaults to OTel enabled. */
  instrumentation: InstrumentationSchema.optional(),
  /** Model provider used by this agent. Optional for backwards compatibility. */
  modelProvider: ModelProviderSchema.optional(),
});

export type AgentEnvSpec = z.infer<typeof AgentEnvSpecSchema>;
