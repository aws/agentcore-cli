import {
  ModelProviderSchema,
  NetworkModeSchema,
  PythonRuntimeSchema,
  SDKFrameworkSchema,
  TargetLanguageSchema,
} from '../constants';
import type { DirectoryPath, FilePath } from '../types';
import { AgentCoreMemoryConfigSchema, MemoryStrategySchema, MemoryStrategyTypeSchema } from './primitives/memory';
import { z } from 'zod';

// Re-export memory types for convenience
export { AgentCoreMemoryConfigSchema, MemoryStrategySchema, MemoryStrategyTypeSchema };
export type { AgentCoreMemoryConfig, MemoryStrategy, MemoryStrategyType } from './primitives/memory';

// Re-export path types for convenience (used by UI to determine file vs directory input)
export type { DirectoryPath, FilePath, PathType } from '../types';

// Re-export constant types for convenience
export type { NetworkMode, PythonRuntime, SDKFramework, TargetLanguage, ModelProvider } from '../constants';

// ============================================================================
// Artifact Types
// ============================================================================

export const ArtifactTypeSchema = z.enum(['CodeZip']);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

// ============================================================================
// Provider Types
// ============================================================================

/**
 * Provider type literals follow [System][Component] naming convention.
 * Each type identifies exactly what infrastructure backs the capability.
 * - AgentCoreMemory: AgentCore's managed memory service
 * - AgentCoreGateway: MCP server running on an AgentCore Gateway
 * - AgentCoreIdentity: AgentCore's workload identity mechanism
 * - AgentCoreCodeBrowser: AgentCore's code browser tool
 */
export const ProviderTypeSchema = z.enum([
  'AgentCoreMemory',
  'AgentCoreGateway',
  'AgentCoreIdentity',
  'AgentCoreCodeBrowser',
]);
export type ProviderType = z.infer<typeof ProviderTypeSchema>;

// ============================================================================
// Branded Path Schemas
// ============================================================================

// Branded path schemas - cast string output to branded path types
const DirectoryPathSchema = z.string().min(1) as unknown as z.ZodType<DirectoryPath>;

/**
 * Python entrypoint validation for Runtime codeConfiguration.
 * Format: "file.py" or "file.py:handler" or "path/file.py:handler"
 */
export const PythonEntrypointSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-zA-Z0-9_][a-zA-Z0-9_/.-]*\.py(:[a-zA-Z_][a-zA-Z0-9_]*)?$/,
    'Must be a Python file path with optional handler (e.g., "main.py:agent" or "src/handler.py:app")'
  ) as unknown as z.ZodType<FilePath>;

// ============================================================================
// Runtime Schemas
// ============================================================================

/**
 * Instrumentation configuration for runtime observability.
 */
const InstrumentationSchema = z.object({
  /**
   * Enable OpenTelemetry instrumentation using opentelemetry-distro.
   * When enabled, the runtime entrypoint is wrapped with opentelemetry-instrument.
   * Defaults to true for new runtimes.
   */
  enableOtel: z.boolean().default(true),
});

export type Instrumentation = z.infer<typeof InstrumentationSchema>;

/**
 * AgentCore Runtime name validation.
 * Pattern: [a-zA-Z][a-zA-Z0-9_]{0,47}
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-runtime.html#cfn-bedrockagentcore-runtime-agentruntimename
 */
const AgentRuntimeNameSchema = z
  .string()
  .min(1, 'Runtime name is required')
  .max(23, 'Runtime name must be 23 characters or less (AWS runtime name limit)')
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,22}$/,
    'Runtime name must start with a letter and contain only alphanumeric characters and underscores'
  );

export const RuntimeSchema = z.object({
  artifact: z.literal('CodeZip'),
  name: AgentRuntimeNameSchema,
  pythonVersion: PythonRuntimeSchema,

  /** Python entrypoint file (e.g., "agent.py" or "src/main.py") */
  entrypoint: PythonEntrypointSchema,

  /** Directory containing the Python code to bundle */
  codeLocation: DirectoryPathSchema,

  /** Instrumentation settings for observability. Defaults to OTel enabled. */
  instrumentation: InstrumentationSchema.optional(),

  networkMode: NetworkModeSchema.optional().default('PUBLIC'),
  description: z.string().optional(),
});

export type Runtime = z.infer<typeof RuntimeSchema>;
export type CodeZipRuntime = Runtime;

// ============================================================================
// Provider Schemas
// ============================================================================

/**
 * Provider name validation (CloudFormation logical ID compatible).
 * Used for provider names and agent environment names in CloudFormation resources.
 * Must begin with a letter and contain only alphanumeric characters.
 * Max 64 chars to leave room for suffixes in generated logical IDs (max 255 total).
 */
export const ProviderNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9]{0,63}$/,
    'Must begin with a letter and contain only alphanumeric characters (max 64 chars)'
  );

// Provider relation - determines ownership vs reference
export const RelationSchema = z.enum(['own', 'use']);
export type Relation = z.infer<typeof RelationSchema>;

// Provider access level for consumers
export const AccessSchema = z.enum(['read', 'readwrite']);
export type Access = z.infer<typeof AccessSchema>;

/**
 * Removal policy for owned resources.
 * Controls what happens when the owning agent is removed.
 *
 * - cascade: Delete the owned resource and clean up all references (default)
 * - restrict: Prevent removal if other agents are using this resource
 */
export const RemovalPolicySchema = z.enum(['cascade', 'restrict']);
export type RemovalPolicy = z.infer<typeof RemovalPolicySchema>;
export const REMOVAL_POLICIES = RemovalPolicySchema.options;

// Common fields shared across providers
export const ProviderCommonFieldsSchema = z.object({
  name: ProviderNameSchema,
  description: z.string(),
});

// Config schemas for AgentCore-managed providers
const AgentCoreCodeBrowserConfigSchema = z.record(z.string(), z.unknown()).optional();

/**
 * Workload Identity name validation.
 * Pattern: [A-Za-z0-9_.-]+
 * Min: 3, Max: 255
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-workloadidentity.html#cfn-bedrockagentcore-workloadidentity-name
 */
export const WorkloadIdentityNameSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(
    /^[A-Za-z0-9_.-]+$/,
    'Workload identity name must contain only alphanumeric characters, underscores, dots, and hyphens (3-255 chars)'
  );

/**
 * Gateway name validation.
 * Pattern: ^([0-9a-zA-Z][-]?){1,100}$
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-gateway.html#cfn-bedrockagentcore-gateway-name
 */
export const GatewayNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^([0-9a-zA-Z][-]?){1,100}$/, 'Gateway name must be alphanumeric with optional hyphens (max 100 chars)');

/**
 * Environment variable name validation (POSIX compliant).
 * Must start with a letter or underscore, followed by letters, digits, or underscores.
 */
export const EnvVarNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'Environment variable name must start with a letter or underscore and contain only letters, digits, and underscores'
  );

// MCP Provider
const AgentCoreGatewayProviderSchema = z
  .object({
    type: z.literal('AgentCoreGateway'),
    gatewayName: GatewayNameSchema,
    envVarName: EnvVarNameSchema,
  })
  .extend(ProviderCommonFieldsSchema.shape);

export const MCPProviderSchema = AgentCoreGatewayProviderSchema;
export type MCPProvider = z.infer<typeof MCPProviderSchema>;
export type AgentCoreGatewayProvider = MCPProvider;

// Memory Provider - relation determines ownership vs reference
// Owner creates and manages the memory resource
const OwnedMemoryProviderSchema = z
  .object({
    type: z.literal('AgentCoreMemory'),
    relation: z.literal('own'),
    /** Removal policy when the owning agent is removed. Defaults to cascade. */
    removalPolicy: RemovalPolicySchema.optional(),
    config: AgentCoreMemoryConfigSchema,
    envVarName: EnvVarNameSchema,
  })
  .extend(ProviderCommonFieldsSchema.shape);

// Consumer references an existing memory by name
const ReferencedMemoryProviderSchema = z
  .object({
    type: z.literal('AgentCoreMemory'),
    relation: z.literal('use'),
    access: AccessSchema.default('readwrite'),
    namespaces: z.array(z.string()).min(1).optional(),
    envVarName: EnvVarNameSchema,
  })
  .extend(ProviderCommonFieldsSchema.shape);

const AgentCoreMemoryProviderSchema = z.discriminatedUnion('relation', [
  OwnedMemoryProviderSchema,
  ReferencedMemoryProviderSchema,
]);

export const MemoryProviderSchema = AgentCoreMemoryProviderSchema;
export type MemoryProvider = z.infer<typeof MemoryProviderSchema>;
export type OwnedMemoryProvider = z.infer<typeof OwnedMemoryProviderSchema>;
export type ReferencedMemoryProvider = z.infer<typeof ReferencedMemoryProviderSchema>;
export type AgentCoreMemoryProvider = OwnedMemoryProvider;

// Identity Provider credential variants
export const IdentityCredentialVariantSchema = z.enum(['ApiKeyCredentialProvider']);
export type IdentityCredentialVariant = z.infer<typeof IdentityCredentialVariantSchema>;

// Identity Provider - relation determines ownership vs reference
// Owner creates and manages the identity credential provider
const OwnedIdentityProviderSchema = z
  .object({
    type: z.literal('AgentCoreIdentity'),
    variant: IdentityCredentialVariantSchema,
    relation: z.literal('own'),
    /** Removal policy when the owning agent is removed. Defaults to cascade. */
    removalPolicy: RemovalPolicySchema.optional(),
    /** The env var to set on the runtime (e.g., AGENTCORE_IDENTITY_OPENAI) */
    envVarName: EnvVarNameSchema,
  })
  .extend(ProviderCommonFieldsSchema.shape);

// Consumer references an existing identity provider by name
const ReferencedIdentityProviderSchema = z
  .object({
    type: z.literal('AgentCoreIdentity'),
    variant: IdentityCredentialVariantSchema,
    relation: z.literal('use'),
    /** The env var to set on the runtime */
    envVarName: EnvVarNameSchema,
  })
  .extend(ProviderCommonFieldsSchema.shape);

const AgentCoreIdentityProviderSchema = z.discriminatedUnion('relation', [
  OwnedIdentityProviderSchema,
  ReferencedIdentityProviderSchema,
]);

export const IdentityProviderSchema = AgentCoreIdentityProviderSchema;
export type IdentityProvider = z.infer<typeof IdentityProviderSchema>;
export type OwnedIdentityProvider = z.infer<typeof OwnedIdentityProviderSchema>;
export type ReferencedIdentityProvider = z.infer<typeof ReferencedIdentityProviderSchema>;
export type AgentCoreIdentityProvider = OwnedIdentityProvider;

// Remote Tools
const AgentCoreCodeBrowserToolSchema = z
  .object({
    type: z.literal('AgentCoreCodeBrowser'),
    config: AgentCoreCodeBrowserConfigSchema,
  })
  .extend(ProviderCommonFieldsSchema.shape);

/**
 * Reference to a peer agent for agent-to-agent invocation.
 * Adding this to an agent's remoteTools grants InvokeAgentRuntime permission
 * and sets an environment variable with the target agent's runtime ARN.
 */
const AgentCoreAgentInvocationSchema = z
  .object({
    type: z.literal('AgentCoreAgentInvocation'),

    /** Name of the target agent to invoke (from spec.agents array) */
    targetAgentName: z.string().min(1),

    /** Environment variable name for the target runtime ARN */
    envVarName: EnvVarNameSchema,
  })
  .extend(ProviderCommonFieldsSchema.shape);

/**
 * Reference to an MCP Runtime tool defined in mcp.json.
 * Adding this grants the agent InvokeAgentRuntime permission and
 * sets an environment variable with the runtime endpoint URL.
 */
const AgentCoreMcpRuntimeRefSchema = z
  .object({
    type: z.literal('AgentCoreMcpRuntime'),

    /** Name of the MCP runtime from mcp.json mcpRuntimeTools */
    mcpRuntimeName: z.string().min(1),

    /** Environment variable name for the runtime endpoint URL */
    envVarName: EnvVarNameSchema,
  })
  .extend(ProviderCommonFieldsSchema.shape);

export const RemoteToolSchema = z.discriminatedUnion('type', [
  AgentCoreCodeBrowserToolSchema,
  AgentCoreAgentInvocationSchema,
  AgentCoreMcpRuntimeRefSchema,
]);
export type RemoteTool = z.infer<typeof RemoteToolSchema>;
export type AgentCoreCodeBrowserTool = z.infer<typeof AgentCoreCodeBrowserToolSchema>;
export type AgentCoreAgentInvocation = z.infer<typeof AgentCoreAgentInvocationSchema>;
export type AgentCoreMcpRuntimeRef = z.infer<typeof AgentCoreMcpRuntimeRefSchema>;
export type AgentCoreCodeBrowserConfig = Record<string, unknown>;

// ============================================================================
// Main Agent Environment Spec
// ============================================================================

export const AgentEnvSpecSchema = z
  .object({
    name: ProviderNameSchema,
    id: z.string().min(1),

    sdkFramework: SDKFrameworkSchema,
    targetLanguage: TargetLanguageSchema,
    modelProvider: ModelProviderSchema,

    runtime: RuntimeSchema,

    mcpProviders: z.array(MCPProviderSchema),
    memoryProviders: z.array(MemoryProviderSchema),
    identityProviders: z.array(IdentityProviderSchema),
    remoteTools: z.array(RemoteToolSchema),
  })
  .strict();

export type AgentEnvSpec = z.infer<typeof AgentEnvSpecSchema>;
