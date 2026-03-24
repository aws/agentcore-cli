import { NetworkModeSchema, NodeRuntimeSchema, PythonRuntimeSchema } from '../constants';
import type { DirectoryPath, FilePath } from '../types';
import { EnvVarNameSchema, GatewayNameSchema } from './agent-env';
import { ToolDefinitionSchema } from './mcp-defs';
import { TagsSchema } from './primitives/tags';
import { z } from 'zod';

// ============================================================================
// MCP-Specific Schemas
// ============================================================================

export const GatewayTargetTypeSchema = z.enum([
  'lambda',
  'mcpServer',
  'openApiSchema',
  'smithyModel',
  'apiGateway',
  'lambdaFunctionArn',
]);
export type GatewayTargetType = z.infer<typeof GatewayTargetTypeSchema>;

// ============================================================================
// Gateway Authorization Schemas
// ============================================================================

export const GatewayAuthorizerTypeSchema = z.enum(['NONE', 'AWS_IAM', 'CUSTOM_JWT']);
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
  .refine(url => url.startsWith('https://'), {
    message: 'OIDC discovery URL must use HTTPS',
  })
  .refine(url => url.endsWith(OIDC_WELL_KNOWN_SUFFIX), {
    message: `OIDC discovery URL must end with '${OIDC_WELL_KNOWN_SUFFIX}'`,
  });

// ── Custom Claims Schemas (matches CFN CustomClaimValidationType) ──

export const ClaimMatchOperatorSchema = z.enum(['EQUALS', 'CONTAINS', 'CONTAINS_ANY']);
export type ClaimMatchOperator = z.infer<typeof ClaimMatchOperatorSchema>;

export const ClaimMatchValueSchema = z
  .object({
    matchValueString: z.string().min(1).optional(),
    matchValueStringList: z.array(z.string().min(1)).min(1).max(255).optional(),
  })
  .refine(data => data.matchValueString !== undefined || data.matchValueStringList !== undefined, {
    message: 'Either matchValueString or matchValueStringList must be provided',
  })
  .refine(data => !(data.matchValueString !== undefined && data.matchValueStringList !== undefined), {
    message: 'Only one of matchValueString or matchValueStringList may be provided',
  });
export type ClaimMatchValue = z.infer<typeof ClaimMatchValueSchema>;

export const InboundTokenClaimValueTypeSchema = z.enum(['STRING', 'STRING_ARRAY']);
export type InboundTokenClaimValueType = z.infer<typeof InboundTokenClaimValueTypeSchema>;

export const CustomClaimValidationSchema = z
  .object({
    inboundTokenClaimName: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_.\-:]+$/, 'Claim name must match [A-Za-z0-9_.-:]+'),
    inboundTokenClaimValueType: InboundTokenClaimValueTypeSchema,
    authorizingClaimMatchValue: z.object({
      claimMatchOperator: ClaimMatchOperatorSchema,
      claimMatchValue: ClaimMatchValueSchema,
    }),
  })
  .strict();
export type CustomClaimValidation = z.infer<typeof CustomClaimValidationSchema>;

// ── Custom JWT Authorizer Configuration ──

/**
 * Custom JWT authorizer configuration.
 * Used when authorizerType is 'CUSTOM_JWT'.
 *
 * At least one of allowedAudience, allowedClients, allowedScopes, or customClaims
 * must be provided. Only discoveryUrl is unconditionally required.
 */
export const CustomJwtAuthorizerConfigSchema = z
  .object({
    /** OIDC discovery URL (e.g., https://cognito-idp.{region}.amazonaws.com/{userPoolId}/.well-known/openid-configuration) */
    discoveryUrl: OidcDiscoveryUrlSchema,
    /** List of allowed audiences (typically client IDs) */
    allowedAudience: z.array(z.string().min(1)).optional(),
    /** List of allowed client IDs */
    allowedClients: z.array(z.string().min(1)).optional(),
    /** List of allowed scopes */
    allowedScopes: z.array(z.string().min(1)).optional(),
    /** Custom claim validations */
    customClaims: z.array(CustomClaimValidationSchema).min(1).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const hasAudience = data.allowedAudience && data.allowedAudience.length > 0;
    const hasClients = data.allowedClients && data.allowedClients.length > 0;
    const hasScopes = data.allowedScopes && data.allowedScopes.length > 0;
    const hasClaims = data.customClaims && data.customClaims.length > 0;

    if (!hasAudience && !hasClients && !hasScopes && !hasClaims) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one of allowedAudience, allowedClients, allowedScopes, or customClaims must be provided',
      });
    }
  });

export type CustomJwtAuthorizerConfig = z.infer<typeof CustomJwtAuthorizerConfigSchema>;

/**
 * Gateway authorizer configuration container.
 */
export const GatewayAuthorizerConfigSchema = z.object({
  customJwtAuthorizer: CustomJwtAuthorizerConfigSchema.optional(),
});

export type GatewayAuthorizerConfig = z.infer<typeof GatewayAuthorizerConfigSchema>;

export const OutboundAuthTypeSchema = z.enum(['OAUTH', 'API_KEY', 'NONE']);
export type OutboundAuthType = z.infer<typeof OutboundAuthTypeSchema>;

export const OutboundAuthSchema = z
  .object({
    type: OutboundAuthTypeSchema.default('NONE'),
    credentialName: z.string().min(1).optional(),
    scopes: z.array(z.string()).optional(),
  })
  .strict();

export type OutboundAuth = z.infer<typeof OutboundAuthSchema>;

// ============================================================================
// Target Type → Auth Rules (single source of truth)
// ============================================================================

/**
 * Outbound authentication rules per gateway target type.
 *
 * - `authRequired` — target cannot be created without outbound auth
 * - `validAuthTypes` — allowed OutboundAuthType values (empty = no outbound auth applicable)
 * - `iamRoleFallback` — CDK passes GATEWAY_IAM_ROLE when no auth configured
 */
export const TARGET_TYPE_AUTH_CONFIG: Record<
  GatewayTargetType,
  { authRequired: boolean; validAuthTypes: readonly OutboundAuthType[]; iamRoleFallback: boolean }
> = {
  openApiSchema: { authRequired: true, validAuthTypes: ['OAUTH', 'API_KEY'], iamRoleFallback: false },
  smithyModel: { authRequired: false, validAuthTypes: [], iamRoleFallback: true },
  apiGateway: { authRequired: false, validAuthTypes: ['API_KEY', 'NONE'], iamRoleFallback: true },
  mcpServer: { authRequired: false, validAuthTypes: ['OAUTH', 'NONE'], iamRoleFallback: false },
  lambda: { authRequired: false, validAuthTypes: ['OAUTH', 'NONE'], iamRoleFallback: false },
  lambdaFunctionArn: { authRequired: false, validAuthTypes: [], iamRoleFallback: true },
};

// ============================================================================
// API Gateway Target Schemas
// ============================================================================

export const ApiGatewayHttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
export type ApiGatewayHttpMethod = z.infer<typeof ApiGatewayHttpMethodSchema>;

export const ApiGatewayToolFilterSchema = z
  .object({
    filterPath: z.string().min(1),
    methods: z.array(ApiGatewayHttpMethodSchema).min(1),
  })
  .strict();

export const ApiGatewayToolOverrideSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
    method: ApiGatewayHttpMethodSchema,
    description: z.string().optional(),
  })
  .strict();

export const ApiGatewayToolConfigurationSchema = z
  .object({
    toolFilters: z.array(ApiGatewayToolFilterSchema).min(1),
    toolOverrides: z.array(ApiGatewayToolOverrideSchema).optional(),
  })
  .strict();

export const ApiGatewayConfigSchema = z
  .object({
    restApiId: z.string().min(1),
    stage: z.string().min(1),
    apiGatewayToolConfiguration: ApiGatewayToolConfigurationSchema,
  })
  .strict();
export type ApiGatewayConfig = z.infer<typeof ApiGatewayConfigSchema>;

export const LambdaFunctionArnConfigSchema = z
  .object({
    lambdaArn: z.string().min(1).max(170),
    toolSchemaFile: z.string().min(1),
  })
  .strict();
export type LambdaFunctionArnConfig = z.infer<typeof LambdaFunctionArnConfigSchema>;

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
// Schema Source (for OpenAPI / Smithy targets)
// ============================================================================

/** S3 reference for an API schema file. */
const SchemaS3SourceSchema = z
  .object({
    uri: z.string().min(1).startsWith('s3://'),
    bucketOwnerAccountId: z.string().optional(),
  })
  .strict();

/** Inline (local file) reference for an API schema file. Path is relative to project root. */
const SchemaInlineSourceSchema = z
  .object({
    path: z.string().min(1),
  })
  .strict();

/** Schema source: either a local file path (read at synth time) or an S3 URI. */
export const SchemaSourceSchema = z.union([
  z.object({ inline: SchemaInlineSourceSchema }).strict(),
  z.object({ s3: SchemaS3SourceSchema }).strict(),
]);
export type SchemaSource = z.infer<typeof SchemaSourceSchema>;

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
    /** Tool definitions. Required for Lambda targets. Optional for MCP Server (discovered via tools/list). */
    toolDefinitions: z.array(ToolDefinitionSchema).optional(),
    /** Compute configuration. Required for Lambda/Runtime scaffold targets. */
    compute: ToolComputeConfigSchema.optional(),
    /** MCP Server endpoint URL. Required for external MCP Server targets. */
    endpoint: z.string().url().optional(),
    /** Outbound auth configuration for the target. */
    outboundAuth: OutboundAuthSchema.optional(),
    /** API Gateway configuration. Required for apiGateway target type. */
    apiGateway: ApiGatewayConfigSchema.optional(),
    /** Schema source for openApiSchema / smithyModel targets. */
    schemaSource: SchemaSourceSchema.optional(),
    /** Lambda Function ARN configuration. Required for lambdaFunctionArn target type. */
    lambdaFunctionArn: LambdaFunctionArnConfigSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.targetType === 'apiGateway') {
      if (!data.apiGateway) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'apiGateway config is required for apiGateway target type',
          path: ['apiGateway'],
        });
      }
      if (data.compute) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'compute is not applicable for apiGateway target type',
          path: ['compute'],
        });
      }
      if (data.endpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'endpoint is not applicable for apiGateway target type',
          path: ['endpoint'],
        });
      }
      if (data.toolDefinitions && data.toolDefinitions.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'toolDefinitions is not applicable for apiGateway target type (tools are auto-discovered)',
          path: ['toolDefinitions'],
        });
      }
      if (data.lambdaFunctionArn) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'lambdaFunctionArn is not applicable for apiGateway target type',
          path: ['lambdaFunctionArn'],
        });
      }
    }
    if (data.targetType === 'openApiSchema' || data.targetType === 'smithyModel') {
      if (!data.schemaSource) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${data.targetType} targets require a schemaSource.`,
          path: ['schemaSource'],
        });
      }
      if (data.compute) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `compute is not applicable for ${data.targetType} target type`,
          path: ['compute'],
        });
      }
      if (data.endpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `endpoint is not applicable for ${data.targetType} target type`,
          path: ['endpoint'],
        });
      }
      if (data.toolDefinitions && data.toolDefinitions.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `toolDefinitions is not applicable for ${data.targetType} target type`,
          path: ['toolDefinitions'],
        });
      }
      if (data.apiGateway) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `apiGateway config is not applicable for ${data.targetType} target type`,
          path: ['apiGateway'],
        });
      }
    }
    if (data.targetType === 'lambdaFunctionArn') {
      if (!data.lambdaFunctionArn) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'lambdaFunctionArn config is required for lambdaFunctionArn target type',
          path: ['lambdaFunctionArn'],
        });
      }
      if (data.compute) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'compute is not applicable for lambdaFunctionArn target type',
          path: ['compute'],
        });
      }
      if (data.endpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'endpoint is not applicable for lambdaFunctionArn target type',
          path: ['endpoint'],
        });
      }
      if (data.apiGateway) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'apiGateway is not applicable for lambdaFunctionArn target type',
          path: ['apiGateway'],
        });
      }
      if (data.outboundAuth) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'outboundAuth is not applicable for lambdaFunctionArn target type',
          path: ['outboundAuth'],
        });
      }
      if (data.toolDefinitions && data.toolDefinitions.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'toolDefinitions is not applicable for lambdaFunctionArn target type (tools are defined via toolSchemaFile)',
          path: ['toolDefinitions'],
        });
      }
    }
    if (data.targetType === 'mcpServer') {
      if (!data.compute && !data.endpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'MCP Server targets require either an endpoint URL or compute configuration.',
        });
      }
      if (data.apiGateway) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'apiGateway is not applicable for mcpServer target type',
          path: ['apiGateway'],
        });
      }
      if (data.lambdaFunctionArn) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'lambdaFunctionArn is not applicable for mcpServer target type',
          path: ['lambdaFunctionArn'],
        });
      }
    }
    if (data.targetType === 'lambda' && !data.compute) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Lambda targets require compute configuration.',
        path: ['compute'],
      });
    }
    if (data.targetType === 'lambda' && (!data.toolDefinitions || data.toolDefinitions.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Lambda targets require at least one tool definition.',
        path: ['toolDefinitions'],
      });
    }
    // Centralized outbound auth validation (driven by TARGET_TYPE_AUTH_CONFIG)
    const authConfig = TARGET_TYPE_AUTH_CONFIG[data.targetType];
    const authType = data.outboundAuth?.type ?? 'NONE';
    if (authConfig.authRequired && authType === 'NONE') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${data.targetType} targets require outbound auth (${authConfig.validAuthTypes.join(' or ')})`,
        path: ['outboundAuth'],
      });
    }
    if (authConfig.validAuthTypes.length === 0 && authType !== 'NONE') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${data.targetType} targets use IAM role auth; outboundAuth is not applicable`,
        path: ['outboundAuth'],
      });
    }
    if (authConfig.validAuthTypes.length > 0 && authType !== 'NONE' && !authConfig.validAuthTypes.includes(authType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${data.targetType} targets do not support ${authType} outbound auth`,
        path: ['outboundAuth'],
      });
    }
    if (data.outboundAuth && data.outboundAuth.type !== 'NONE' && !data.outboundAuth.credentialName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${data.outboundAuth.type} outbound auth requires a credentialName.`,
        path: ['outboundAuth', 'credentialName'],
      });
    }
  });

export type AgentCoreGatewayTarget = z.infer<typeof AgentCoreGatewayTargetSchema>;

// ============================================================================
// Gateway Exception Level
// ============================================================================

export const GatewayExceptionLevelSchema = z.enum(['NONE', 'DEBUG']);
export type GatewayExceptionLevel = z.infer<typeof GatewayExceptionLevelSchema>;

// ============================================================================
// Gateway Policy Engine Configuration
// ============================================================================

export const PolicyEngineModeSchema = z.enum(['LOG_ONLY', 'ENFORCE']);
export type PolicyEngineMode = z.infer<typeof PolicyEngineModeSchema>;

export const GatewayPolicyEngineConfigurationSchema = z
  .object({
    policyEngineName: z.string().min(1),
    mode: PolicyEngineModeSchema,
  })
  .strict();
export type GatewayPolicyEngineConfiguration = z.infer<typeof GatewayPolicyEngineConfigurationSchema>;

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
    /** Whether to enable semantic search for tool discovery. Defaults to true. */
    enableSemanticSearch: z.boolean().default(true),
    /** Exception verbosity level. 'NONE' = generic errors (default), 'DEBUG' = verbose errors. */
    exceptionLevel: GatewayExceptionLevelSchema.default('NONE'),
    /** Policy engine configuration for Cedar-based authorization of tool calls. */
    policyEngineConfiguration: GatewayPolicyEngineConfigurationSchema.optional(),
    tags: TagsSchema.optional(),
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
// MCP Spec Type (convenience alias)
// ============================================================================

/**
 * Shape of MCP-related fields within AgentCoreProjectSpec.
 * These fields are now part of agentcore.json (previously in mcp.json).
 */
export interface AgentCoreMcpSpec {
  agentCoreGateways: AgentCoreGateway[];
  mcpRuntimeTools?: AgentCoreMcpRuntimeTool[];
  unassignedTargets?: AgentCoreGatewayTarget[];
}
