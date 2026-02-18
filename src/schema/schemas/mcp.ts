import { NetworkModeSchema, NodeRuntimeSchema, PythonRuntimeSchema } from '../constants';
import type { DirectoryPath, FilePath } from '../types';
import { EnvVarNameSchema, GatewayNameSchema } from './agent-env';
import { ToolDefinitionSchema } from './mcp-defs';
import { z } from 'zod';

// ============================================================================
// MCP-Specific Schemas
// ============================================================================

export const GatewayTargetTypeSchema = z.enum(['lambda', 'mcpServer', 'openApiSchema', 'smithyModel']);
export type GatewayTargetType = z.infer<typeof GatewayTargetTypeSchema>;

// ============================================================================
// Gateway Authorization Schemas
// ============================================================================

export const GatewayAuthorizerTypeSchema = z.enum(['NONE', 'CUSTOM_JWT']);
export type GatewayAuthorizerType = z.infer<typeof GatewayAuthorizerTypeSchema>;

/** OIDC well-known configuration endpoint suffix (per OpenID Connect Discovery 1.0 spec) */
const OIDC_WELL_KNOWN_SUFFIX = '/.well-known/openid-configuration';

/**
 * OIDC Discovery URL schema.
 * Must be a valid URL ending with the standard OIDC well-known endpoint.
 * @see https://openid.net/specs/openid-connect-discovery-1_0.html
 */
const OidcDiscoveryUrlSchema = z
  .string()
  .url('Must be a valid URL')
  .refine(url => url.endsWith(OIDC_WELL_KNOWN_SUFFIX), {
    message: `OIDC discovery URL must end with '${OIDC_WELL_KNOWN_SUFFIX}'`,
  });

/**
 * Custom JWT authorizer configuration.
 * Used when authorizerType is 'CUSTOM_JWT'.
 */
export const CustomJwtAuthorizerConfigSchema = z.object({
  /** OIDC discovery URL (e.g., https://cognito-idp.{region}.amazonaws.com/{userPoolId}/.well-known/openid-configuration) */
  discoveryUrl: OidcDiscoveryUrlSchema,
  /** List of allowed audiences (typically client IDs). Empty array means no audience validation. */
  allowedAudience: z.array(z.string().min(1)),
  /** List of allowed client IDs */
  allowedClients: z.array(z.string().min(1)).min(1),
});

export type CustomJwtAuthorizerConfig = z.infer<typeof CustomJwtAuthorizerConfigSchema>;

/**
 * Gateway authorizer configuration container.
 */
export const GatewayAuthorizerConfigSchema = z.object({
  customJwtAuthorizer: CustomJwtAuthorizerConfigSchema.optional(),
});

export type GatewayAuthorizerConfig = z.infer<typeof GatewayAuthorizerConfigSchema>;

export const McpImplLanguageSchema = z.enum(['TypeScript', 'Python']);
export type McpImplementationLanguage = z.infer<typeof McpImplLanguageSchema>;

export const ComputeHostSchema = z.enum(['Lambda', 'AgentCoreRuntime']);
export type ComputeHost = z.infer<typeof ComputeHostSchema>;

// ============================================================================
// Branded Path Schemas
// ============================================================================

// Branded path schemas - cast string output to branded path types
const DirectoryPathSchema = z.string().min(1) as unknown as z.ZodType<DirectoryPath>;

// ============================================================================
// Tool Implementation Binding
// ============================================================================

/**
 * Code-based tool implementation (Python, TypeScript).
 *
 * The CLI is responsible for:
 * - installing dependencies
 * - building / bundling
 * - creating a zip artifact
 * - uploading artifacts to S3
 */
export const ToolImplementationBindingSchema = z
  .object({
    language: z.enum(['TypeScript', 'Python']),
    path: z.string().min(1),
    handler: z.string().min(1),
  })
  .strict();

export type ToolImplementationBinding = z.infer<typeof ToolImplementationBindingSchema>;

// ============================================================================
// IAM Policy Document
// ============================================================================

/**
 * Opaque IAM policy document.
 *
 * This is passed through verbatim to CloudFormation / IAM.
 * AgentCore does not validate, transform, or provide compatibility guarantees.
 */
export const IamPolicyDocumentSchema = z
  .object({
    Version: z.string(),
    Statement: z.array(z.unknown()),
  })
  .passthrough(); // Allow additional IAM policy fields

export type IamPolicyDocument = z.infer<typeof IamPolicyDocumentSchema>;

// ============================================================================
// Runtime Configuration
// ============================================================================

/**
 * AgentCore Runtime name validation.
 * Pattern: [a-zA-Z][a-zA-Z0-9_]{0,47}
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-runtime.html#cfn-bedrockagentcore-runtime-agentruntimename
 */
const AgentRuntimeNameSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

/**
 * Python entrypoint validation for Runtime codeConfiguration.
 * Format: "file.py" or "file.py:handler" or "path/file.py:handler"
 */
const PythonEntrypointSchema = z
  .string()
  .min(1)
  .regex(
    // eslint-disable-next-line security/detect-unsafe-regex -- character class quantifiers don't cause backtracking
    /^[a-zA-Z0-9_][a-zA-Z0-9_/.-]*\.py(:[a-zA-Z_][a-zA-Z0-9_]*)?$/,
    'Must be a Python file path with optional handler (e.g., "main.py:agent" or "src/handler.py:app")'
  ) as unknown as z.ZodType<FilePath>;

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

const CodeZipRuntimeConfigSchema = z
  .object({
    artifact: z.literal('CodeZip'),
    pythonVersion: PythonRuntimeSchema,
    name: AgentRuntimeNameSchema,
    entrypoint: PythonEntrypointSchema,
    codeLocation: DirectoryPathSchema,
    /** Instrumentation settings for observability. Defaults to OTel enabled. */
    instrumentation: InstrumentationSchema.optional(),
    networkMode: NetworkModeSchema.optional().default('PUBLIC'),
    description: z.string().optional(),
  })
  .strict();

export type CodeZipRuntimeConfig = z.infer<typeof CodeZipRuntimeConfigSchema>;

/**
 * Runtime configuration for AgentCore Runtime (MCP mode).
 * Explicit CodeZip artifact configuration - no CLI-managed defaults.
 */
export const RuntimeConfigSchema = CodeZipRuntimeConfigSchema;

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

// ============================================================================
// Compute Configuration
// ============================================================================

/**
 * Lambda compute configuration schema.
 * Lambda supports both Python and TypeScript.
 */
const LambdaComputeConfigSchema = z
  .object({
    host: z.literal('Lambda'),
    implementation: ToolImplementationBindingSchema,
    nodeVersion: NodeRuntimeSchema.optional(),
    pythonVersion: PythonRuntimeSchema.optional(),
    timeout: z.number().int().min(1).max(900).optional(),
    memorySize: z.number().int().min(128).max(10240).optional(),
    iamPolicy: IamPolicyDocumentSchema.optional(),
  })
  .strict()
  .refine(
    data => {
      // TypeScript requires nodeVersion
      if (data.implementation.language === 'TypeScript' && !data.nodeVersion) {
        return false;
      }
      // Python requires pythonVersion
      if (data.implementation.language === 'Python' && !data.pythonVersion) {
        return false;
      }
      // Other (container) does not require runtime version - uses container image
      return true;
    },
    {
      message: 'TypeScript Lambda must specify nodeVersion, Python Lambda must specify pythonVersion',
    }
  );

export type LambdaComputeConfig = z.infer<typeof LambdaComputeConfigSchema>;

/**
 * AgentCore Runtime compute configuration schema.
 * AgentCore Runtime ONLY supports Python.
 */
const AgentCoreRuntimeComputeConfigSchema = z
  .object({
    host: z.literal('AgentCoreRuntime'),
    implementation: ToolImplementationBindingSchema,
    runtime: RuntimeConfigSchema.optional(),
    iamPolicy: IamPolicyDocumentSchema.optional(),
  })
  .strict()
  .refine(data => data.implementation.language === 'Python', {
    message: 'AgentCore Runtime only supports Python',
  });

export type AgentCoreRuntimeComputeConfig = z.infer<typeof AgentCoreRuntimeComputeConfigSchema>;

/**
 * Tool compute configuration (discriminated union).
 */
export const ToolComputeConfigSchema = z.discriminatedUnion('host', [
  LambdaComputeConfigSchema,
  AgentCoreRuntimeComputeConfigSchema,
]);

export type ToolComputeConfig = z.infer<typeof ToolComputeConfigSchema>;

// ============================================================================
// Gateway Target
// ============================================================================

/**
 * A gateway target binds one or more ToolDefinitions to compute that services them.
 *
 * A single Lambda or AgentCoreRuntime can expose multiple tools. The gateway routes
 * tool invocations to the appropriate target based on tool name.
 *
 * If compute is omitted, the tools are treated as external or abstract targets.
 */
export const AgentCoreGatewayTargetSchema = z
  .object({
    name: z.string().min(1),
    targetType: GatewayTargetTypeSchema,
    toolDefinitions: z.array(ToolDefinitionSchema).min(1),
    compute: ToolComputeConfigSchema.optional(),
  })
  .strict();

export type AgentCoreGatewayTarget = z.infer<typeof AgentCoreGatewayTargetSchema>;

// ============================================================================
// Gateway
// ============================================================================

/**
 * Gateway abstraction with opinionated defaults.
 * Supports NONE (default) or CUSTOM_JWT authorizer types.
 */
export const AgentCoreGatewaySchema = z
  .object({
    name: GatewayNameSchema,
    description: z.string().optional(),
    targets: z.array(AgentCoreGatewayTargetSchema),
    /** Authorization type for the gateway. Defaults to 'NONE'. */
    authorizerType: GatewayAuthorizerTypeSchema.default('NONE'),
    /** Authorizer configuration. Required when authorizerType is 'CUSTOM_JWT'. */
    authorizerConfiguration: GatewayAuthorizerConfigSchema.optional(),
  })
  .strict()
  .refine(
    data => {
      // If authorizerType is CUSTOM_JWT, customJwtAuthorizer config must be provided
      if (data.authorizerType === 'CUSTOM_JWT') {
        return data.authorizerConfiguration?.customJwtAuthorizer !== undefined;
      }
      return true;
    },
    {
      message: 'customJwtAuthorizer configuration is required when authorizerType is CUSTOM_JWT',
      path: ['authorizerConfiguration'],
    }
  );

export type AgentCoreGateway = z.infer<typeof AgentCoreGatewaySchema>;

// ============================================================================
// MCP Runtime Tool
// ============================================================================

/**
 * Binding from an MCP runtime tool to an agent.
 * When present, the agent is granted InvokeAgentRuntime permission
 * and receives the runtime ARN in the specified environment variable.
 */
export const McpRuntimeBindingSchema = z
  .object({
    agentName: z.string().min(1),
    envVarName: EnvVarNameSchema,
  })
  .strict();

export type McpRuntimeBinding = z.infer<typeof McpRuntimeBindingSchema>;

/**
 * AgentCore MCP Runtime tool servers.
 *
 * These are not behind a Gateway. They are deployed as AgentCoreRuntime compute
 * and are directly addressable by agents via the generated DNS endpoint.
 *
 * Use the `bindings` array to grant agents permission to invoke this tool.
 * Each binding grants InvokeAgentRuntime permission and sets an environment variable
 * with the runtime ARN on the bound agent.
 */
export const AgentCoreMcpRuntimeToolSchema = z
  .object({
    name: z.string().min(1),
    toolDefinition: ToolDefinitionSchema,
    compute: AgentCoreRuntimeComputeConfigSchema,
    bindings: z.array(McpRuntimeBindingSchema).optional(),
  })
  .strict();

export type AgentCoreMcpRuntimeTool = z.infer<typeof AgentCoreMcpRuntimeToolSchema>;

// ============================================================================
// Top-Level MCP Spec
// ============================================================================

/**
 * Top-level MCP schema.
 */
export const AgentCoreMcpSpecSchema = z
  .object({
    agentCoreGateways: z.array(AgentCoreGatewaySchema),
    mcpRuntimeTools: z.array(AgentCoreMcpRuntimeToolSchema).optional(),
  })
  .strict();

export type AgentCoreMcpSpec = z.infer<typeof AgentCoreMcpSpecSchema>;
