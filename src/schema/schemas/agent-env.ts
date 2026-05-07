/**
 * Agent Schema v2 - Clean, simplified model
 *
 * @module agent-env
 */
import {
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
 *
 * Per https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-header-allowlist.html
 * AgentCore Runtime accepts any HTTP header name that is:
 *   - composed of alphanumerics, hyphens, or underscores;
 *   - not in the restricted-headers list (Cookie, Host, Content-Type, etc.);
 *   - not starting with `x-amz-` (reserved for AWS SigV4);
 *   - not starting with `x-amzn-` unless it begins with the AgentCore custom prefix.
 *
 * `Authorization` is allowed (and requires a custom JWT authorizer to be configured).
 * Headers prefixed with `X-Amzn-Bedrock-AgentCore-Runtime-Custom-` continue to be
 * supported for backward compatibility. Maximum 20 headers (case-insensitive,
 * duplicates rejected).
 */
export const HEADER_ALLOWLIST_PREFIX = 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-';
export const MAX_HEADER_ALLOWLIST_SIZE = 20;

/**
 * Valid header-name character set accepted by AgentCore Runtime: alphanumerics,
 * hyphens, and underscores. (Looser than the legacy `/^[A-Za-z0-9-]+$/` which
 * disallowed underscores.)
 */
export const HEADER_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

/**
 * Restricted header names (case-insensitive). Sourced from
 * https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-header-allowlist.html
 * "Restricted headers" table.
 */
export const RESTRICTED_HEADER_NAMES: ReadonlySet<string> = new Set(
  [
    // Authentication & Authorization (Authorization itself is allowed)
    'Proxy-Authorization',
    'WWW-Authenticate',
    // Content Negotiation
    'Accept',
    'Accept-Charset',
    'Accept-Encoding',
    'Accept-Language',
    'Content-Type',
    'Content-Length',
    'Content-Encoding',
    'Content-Language',
    'Content-Location',
    'Content-Range',
    // Caching
    'Cache-Control',
    'ETag',
    'Expires',
    'If-Match',
    'If-Modified-Since',
    'If-None-Match',
    'If-Range',
    'If-Unmodified-Since',
    'Last-Modified',
    'Pragma',
    'Vary',
    // Connection management
    'Connection',
    'Keep-Alive',
    'Proxy-Connection',
    'Upgrade',
    // Request context
    'Host',
    'User-Agent',
    'Referer',
    'From',
    // Range / transfer
    'Range',
    'Accept-Ranges',
    'Transfer-Encoding',
    'TE',
    'Trailer',
    // Server information
    'Server',
    'Date',
    'Location',
    'Retry-After',
    // Cookies
    'Set-Cookie',
    'Cookie',
    // Security
    'Content-Security-Policy',
    'Content-Security-Policy-Report-Only',
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'X-Frame-Options',
    'X-XSS-Protection',
    'Referrer-Policy',
    'Permissions-Policy',
    'Cross-Origin-Embedder-Policy',
    'Cross-Origin-Opener-Policy',
    'Cross-Origin-Resource-Policy',
    // CORS
    'Access-Control-Allow-Origin',
    'Access-Control-Allow-Methods',
    'Access-Control-Allow-Headers',
    'Access-Control-Allow-Credentials',
    'Access-Control-Expose-Headers',
    'Access-Control-Max-Age',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers',
    'Origin',
    // Client hints
    'Accept-CH',
    'Accept-CH-Lifetime',
    'DPR',
    'Width',
    'Viewport-Width',
    'Downlink',
    'ECT',
    'RTT',
    'Save-Data',
    // Experimental / proposed
    'Clear-Site-Data',
    'Feature-Policy',
    'Expect-CT',
    'Public-Key-Pins',
    'Public-Key-Pins-Report-Only',
    // Proxy
    'Via',
    'Forwarded',
    'X-Forwarded-For',
    'X-Forwarded-Host',
    'X-Forwarded-Proto',
    'X-Real-IP',
    'X-Requested-With',
    'X-CSRF-Token',
    // IP spoofing / URL manipulation
    'True-Client-IP',
    'X-Client-IP',
    'X-Cluster-Client-IP',
    'X-Originating-IP',
    'X-Source-IP',
    'X-Original-URL',
    'X-Original-Host',
    'X-Rewrite-URL',
    // CDN / Proxy
    'CF-Ray',
    'CF-Connecting-IP',
    'X-Amz-Cf-Id',
    'X-Cache',
    'X-Served-By',
    // HTTP/2 pseudo headers
    ':method',
    ':path',
    ':scheme',
    ':authority',
    ':status',
    // Server push
    'Link',
    // WebSocket
    'Sec-WebSocket-Key',
    'Sec-WebSocket-Accept',
    'Sec-WebSocket-Version',
    'Sec-WebSocket-Protocol',
    'Sec-WebSocket-Extensions',
  ].map(s => s.toLowerCase())
);

/**
 * Validate a single header name against the AgentCore Runtime allowlist rules.
 * Returns `null` if the header is allowed, otherwise a human-readable rejection
 * reason.
 */
export function getHeaderRejectionReason(name: string): string | null {
  if (typeof name !== 'string' || name.length === 0) {
    return 'Header name must be a non-empty string.';
  }
  if (!HEADER_NAME_REGEX.test(name)) {
    return `Invalid header name "${name}". Header names may only contain letters, numbers, hyphens, and underscores.`;
  }
  const lower = name.toLowerCase();
  // Authorization is explicitly allowed (requires customJWTAuthorizer at runtime).
  if (lower === 'authorization') return null;
  // Backward-compatible AgentCore custom prefix is always allowed.
  if (lower.startsWith(HEADER_ALLOWLIST_PREFIX.toLowerCase())) return null;
  // x-amz-* is reserved for AWS SigV4 signing.
  if (lower.startsWith('x-amz-')) {
    return `Header "${name}" is reserved (the "x-amz-" prefix is reserved for AWS SigV4 signing).`;
  }
  // x-amzn-* is reserved except for the AgentCore custom prefix (handled above).
  if (lower.startsWith('x-amzn-')) {
    return `Header "${name}" is reserved (the "x-amzn-" prefix is reserved; only headers starting with "${HEADER_ALLOWLIST_PREFIX}" are allowed).`;
  }
  if (RESTRICTED_HEADER_NAMES.has(lower)) {
    return `Header "${name}" is in the restricted-headers list and cannot be configured for propagation.`;
  }
  return null;
}

export const RequestHeaderAllowlistSchema = z
  .array(
    z.string().superRefine((val, ctx) => {
      const reason = getHeaderRejectionReason(val);
      if (reason) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: reason });
      }
    })
  )
  .max(MAX_HEADER_ALLOWLIST_SIZE, `Maximum ${MAX_HEADER_ALLOWLIST_SIZE} headers allowed`)
  .superRefine((arr, ctx) => {
    const seen = new Set<string>();
    arr.forEach((v, i) => {
      const k = typeof v === 'string' ? v.toLowerCase() : '';
      if (seen.has(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i],
          message: `Duplicate header (case-insensitive): "${v}"`,
        });
      }
      seen.add(k);
    });
  });

/**
 * Session storage configuration for filesystem persistence.
 * Files written to mountPath persist across session stop/resume cycles.
 */
export const SessionStorageSchema = z.object({
  /** Absolute mount path under /mnt with exactly one subdirectory level (e.g. /mnt/data). */
  mountPath: z
    .string()
    .regex(/^\/mnt\/[^/]+$/, 'Must be a path under /mnt with exactly one subdirectory (e.g. /mnt/data)'),
});
export type SessionStorage = z.infer<typeof SessionStorageSchema>;

export const FilesystemConfigurationSchema = z.object({
  sessionStorage: SessionStorageSchema,
});
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
    /** Custom Dockerfile name for Container builds. Must be a filename, not a path. Default: 'Dockerfile' */
    dockerfile: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'Must be a filename (no path separators or traversal)')
      .optional(),
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
    // If adding more Container-specific fields, consider consolidating into a containerConfig object (see networkConfig pattern)
    if (data.build !== 'Container' && data.dockerfile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'dockerfile is only allowed for Container builds',
        path: ['dockerfile'],
      });
    }
  });

export type AgentEnvSpec = z.infer<typeof AgentEnvSpecSchema>;
