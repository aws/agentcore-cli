import { NetworkModeSchema, NodeRuntimeSchema, PythonRuntimeSchema } from '../constants';
import type { DirectoryPath, FilePath } from '../types';
import { EnvVarNameSchema, GatewayNameSchema } from './agent-env';
import { GatewayAuthorizerConfigSchema, GatewayAuthorizerTypeSchema } from './auth';
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
  'httpRuntime',
  'connector',
  'passthrough',
  'webSearch',
]);
export type GatewayTargetType = z.infer<typeof GatewayTargetTypeSchema>;

/**
 * Target types that use the non-MCP (HTTP) protocol.
 * These targets require a gateway with protocolType: "None".
 */
export const NON_MCP_TARGET_TYPES: readonly GatewayTargetType[] = ['httpRuntime', 'passthrough'] as const;

/**
 * Target types that use the MCP protocol.
 */
export const MCP_TARGET_TYPES: readonly GatewayTargetType[] = [
  'lambda',
  'mcpServer',
  'openApiSchema',
  'smithyModel',
  'apiGateway',
  'lambdaFunctionArn',
] as const;

// ============================================================================
// Connector (managed-service gateway target)
// ============================================================================

/**
 * Managed-service connector identifiers. The L3 maps each one to an operation
 * name + Enabled list via CONNECTOR_DEFAULTS.
 *
 * Spec note: the original DevEx doc (cli-knowledge-bases-devex.md) uses
 * `agentic-retrieve`, but the service accepts `bedrock-agentic-retrieve`. The
 * latter is canonical.
 */
export const CONNECTOR_ID = {
  BEDROCK_KNOWLEDGE_BASES: 'bedrock-knowledge-bases',
  BEDROCK_AGENTIC_RETRIEVE: 'bedrock-agentic-retrieve',
} as const;
export const CONNECTOR_ID_VALUES = [
  CONNECTOR_ID.BEDROCK_KNOWLEDGE_BASES,
  CONNECTOR_ID.BEDROCK_AGENTIC_RETRIEVE,
] as const;
export const ConnectorIdSchema = z.enum(CONNECTOR_ID_VALUES);
export type ConnectorId = z.infer<typeof ConnectorIdSchema>;

/**
 * Real Bedrock Knowledge Base IDs are 10 uppercase alphanumeric chars.
 * KB names follow the standard primitive-name shape (1-48 chars, starts with a letter).
 * The two formats can never collide, so a connector target's `knowledgeBaseId`
 * field is unambiguously a project KB name or a literal external KB ID.
 */
export const REAL_KB_ID_PATTERN = /^[A-Z0-9]{10}$/;

// ============================================================================
// Gateway Authorization Schemas
// ============================================================================
// Auth schemas (GatewayAuthorizerTypeSchema, CustomJwtAuthorizerConfigSchema, etc.)
// are defined in ./auth.ts and exported via the barrel (index.ts).

export const OutboundAuthTypeSchema = z.enum(['OAUTH', 'API_KEY', 'NONE', 'GATEWAY_IAM_ROLE', 'JWT_PASSTHROUGH']);
export type OutboundAuthType = z.infer<typeof OutboundAuthTypeSchema>;

export const OutboundAuthSchema = z
  .object({
    type: OutboundAuthTypeSchema.default('NONE'),
    credentialName: z.string().min(1).optional(),
    scopes: z.array(z.string()).optional(),
    service: z.string().min(1).max(64).optional(),
    region: z.string().min(1).max(32).optional(),
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
  lambda: { authRequired: false, validAuthTypes: ['OAUTH', 'NONE'], iamRoleFallback: true },
  lambdaFunctionArn: { authRequired: false, validAuthTypes: ['OAUTH', 'NONE'], iamRoleFallback: true },
  httpRuntime: { authRequired: false, validAuthTypes: ['OAUTH', 'NONE'], iamRoleFallback: true },
  // Connector targets call the underlying managed service (Bedrock KB, etc.)
  // via the gateway's IAM role. No outbound auth applies.
  connector: { authRequired: false, validAuthTypes: [], iamRoleFallback: true },
  passthrough: {
    authRequired: true,
    validAuthTypes: ['GATEWAY_IAM_ROLE', 'OAUTH', 'JWT_PASSTHROUGH'],
    iamRoleFallback: false,
  },
  // Amazon Web Search is invoked via the gateway's IAM role. No outbound auth.
  webSearch: { authRequired: false, validAuthTypes: [], iamRoleFallback: true },
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
// HTTP Runtime Configuration
// ============================================================================

export const HttpRuntimeConfigSchema = z
  .object({
    runtime: z.string().min(1),
    runtimeEndpoint: z.string().min(1).optional(),
  })
  .strict();

export type HttpRuntimeConfig = z.infer<typeof HttpRuntimeConfigSchema>;

// ============================================================================
// Passthrough Target Configuration
// ============================================================================

export const StickinessConfigSchema = z
  .object({
    identifier: z.string().min(1).max(256),
    timeout: z.number().int().min(1).max(86400).optional(),
  })
  .strict();
export type StickinessConfig = z.infer<typeof StickinessConfigSchema>;

/**
 * Passthrough protocol type. HTTP is NOT valid — use CUSTOM for plain HTTP/REST backends.
 */
export const PassthroughProtocolTypeSchema = z.enum(['MCP', 'A2A', 'INFERENCE', 'CUSTOM']);
export type PassthroughProtocolType = z.infer<typeof PassthroughProtocolTypeSchema>;

export const PassthroughConfigSchema = z
  .object({
    endpoint: z
      .string()
      .min(1)
      .regex(/^https:\/\/[a-zA-Z0-9\-.]+(:[0-9]{1,5})?(\/.*)?$/, 'Must be a valid HTTPS URL'),
    /** Protocol type for the passthrough backend. Defaults to CUSTOM (generic HTTP/REST). */
    protocolType: PassthroughProtocolTypeSchema.default('CUSTOM'),
    stickinessConfiguration: StickinessConfigSchema.optional(),
  })
  .strict();
export type PassthroughConfig = z.infer<typeof PassthroughConfigSchema>;

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
    /** Endpoint URL for mcpServer targets. */
    endpoint: z.string().url().optional(),
    /** Outbound auth configuration for the target. */
    outboundAuth: OutboundAuthSchema.optional(),
    /** API Gateway configuration. Required for apiGateway target type. */
    apiGateway: ApiGatewayConfigSchema.optional(),
    /** Schema source for openApiSchema / smithyModel targets. */
    schemaSource: SchemaSourceSchema.optional(),
    /** Lambda Function ARN configuration. Required for lambdaFunctionArn target type. */
    lambdaFunctionArn: LambdaFunctionArnConfigSchema.optional(),
    /** HTTP Runtime configuration. Required for httpRuntime target type. */
    httpRuntime: HttpRuntimeConfigSchema.optional(),
    /**
     * Managed-service connector identifier. Required for `connector` target type.
     */
    connectorId: ConnectorIdSchema.optional(),
    /**
     * For `bedrock-knowledge-bases` connector targets: either a project KB
     * name (references an entry in `knowledgeBases[]` on the project spec)
     * or a literal 10-character KB ID (refers to an external KB this project
     * does not own). The L3 disambiguates by regex match. Mutually exclusive
     * with `knowledgeBaseIds`.
     */
    knowledgeBaseId: z
      .string()
      .min(1)
      .max(48)
      .regex(/^[a-zA-Z0-9_-]+$/, 'Must be a KB name (1-48 chars, letters/digits/dash/underscore) or a 10-char KB ID')
      .optional(),
    /**
     * For `bedrock-agentic-retrieve` connector targets only. List of project
     * KB names or literal 10-char external KB IDs that this orchestrated
     * retriever should fan out across. Each entry is disambiguated the same
     * way `knowledgeBaseId` is. Mutually exclusive with `knowledgeBaseId`.
     */
    knowledgeBaseIds: z
      .array(
        z
          .string()
          .min(1)
          .max(48)
          .regex(/^[a-zA-Z0-9_-]+$/, 'Each entry must be a KB name (1-48 chars) or a 10-char KB ID')
      )
      .min(1)
      .optional(),
    /** Passthrough configuration. Required for passthrough target type. */
    passthrough: PassthroughConfigSchema.optional(),
    /**
     * For `webSearch` target type only. Domains to exclude from web search
     * results. Maps to the connector's `domainFilter.exclude` parameterValue
     * at synth time.
     */
    excludeDomains: z.array(z.string().min(1)).min(1).optional(),
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
    if (data.targetType === 'httpRuntime') {
      if (!data.httpRuntime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'httpRuntime targets require an httpRuntime configuration (with a runtime reference).',
          path: ['httpRuntime'],
        });
      }
      if (data.endpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'httpRuntime targets should use httpRuntime.runtimeEndpoint instead of endpoint.',
          path: ['endpoint'],
        });
      }
      if (data.compute) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'compute is not applicable for httpRuntime target type',
          path: ['compute'],
        });
      }
      if (data.apiGateway) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'apiGateway is not applicable for httpRuntime target type',
          path: ['apiGateway'],
        });
      }
      if (data.lambdaFunctionArn) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'lambdaFunctionArn is not applicable for httpRuntime target type',
          path: ['lambdaFunctionArn'],
        });
      }
      if (data.toolDefinitions && data.toolDefinitions.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'toolDefinitions is not applicable for httpRuntime target type',
          path: ['toolDefinitions'],
        });
      }
    }
    if (data.targetType === 'passthrough') {
      if (!data.passthrough) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'passthrough targets require a passthrough configuration (with an endpoint).',
          path: ['passthrough'],
        });
      }
      if (data.endpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'passthrough targets should use passthrough.endpoint instead of endpoint.',
          path: ['endpoint'],
        });
      }
      if (data.compute) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'compute is not applicable for passthrough target type',
          path: ['compute'],
        });
      }
      if (data.apiGateway) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'apiGateway is not applicable for passthrough target type',
          path: ['apiGateway'],
        });
      }
      if (data.lambdaFunctionArn) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'lambdaFunctionArn is not applicable for passthrough target type',
          path: ['lambdaFunctionArn'],
        });
      }
      if (data.httpRuntime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'httpRuntime is not applicable for passthrough target type',
          path: ['httpRuntime'],
        });
      }
      if (data.toolDefinitions && data.toolDefinitions.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'toolDefinitions is not applicable for passthrough target type',
          path: ['toolDefinitions'],
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
    if (data.targetType === 'connector') {
      if (!data.connectorId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'connectorId is required for connector target type',
          path: ['connectorId'],
        });
      }
      if (data.connectorId === CONNECTOR_ID.BEDROCK_KNOWLEDGE_BASES) {
        if (!data.knowledgeBaseId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `knowledgeBaseId is required for connectorId '${data.connectorId}'`,
            path: ['knowledgeBaseId'],
          });
        }
        if (data.knowledgeBaseIds) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `knowledgeBaseIds is not applicable for connectorId '${data.connectorId}' (use knowledgeBaseId)`,
            path: ['knowledgeBaseIds'],
          });
        }
      }
      if (data.connectorId === CONNECTOR_ID.BEDROCK_AGENTIC_RETRIEVE) {
        if (!data.knowledgeBaseIds || data.knowledgeBaseIds.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `knowledgeBaseIds (non-empty) is required for connectorId '${data.connectorId}'`,
            path: ['knowledgeBaseIds'],
          });
        }
        if (data.knowledgeBaseId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `knowledgeBaseId is not applicable for connectorId '${data.connectorId}' (use knowledgeBaseIds)`,
            path: ['knowledgeBaseId'],
          });
        }
      }
      if (data.excludeDomains) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `excludeDomains only applies to webSearch target type`,
          path: ['excludeDomains'],
        });
      }
      if (data.compute) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'compute is not applicable for connector target type',
          path: ['compute'],
        });
      }
      if (data.endpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'endpoint is not applicable for connector target type',
          path: ['endpoint'],
        });
      }
      if (data.toolDefinitions && data.toolDefinitions.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'toolDefinitions is not applicable for connector target type',
          path: ['toolDefinitions'],
        });
      }
      if (data.apiGateway) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'apiGateway is not applicable for connector target type',
          path: ['apiGateway'],
        });
      }
      if (data.lambdaFunctionArn) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'lambdaFunctionArn is not applicable for connector target type',
          path: ['lambdaFunctionArn'],
        });
      }
      if (data.schemaSource) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'schemaSource is not applicable for connector target type',
          path: ['schemaSource'],
        });
      }
    }
    if (data.targetType === 'webSearch') {
      // Web search is invoked via the gateway's IAM role and takes only an
      // optional excludeDomains list. Reject anything else.
      if (data.compute) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'compute is not applicable for webSearch target type',
          path: ['compute'],
        });
      }
      if (data.endpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'endpoint is not applicable for webSearch target type',
          path: ['endpoint'],
        });
      }
      if (data.toolDefinitions && data.toolDefinitions.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'toolDefinitions is not applicable for webSearch target type',
          path: ['toolDefinitions'],
        });
      }
      if (data.apiGateway) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'apiGateway is not applicable for webSearch target type',
          path: ['apiGateway'],
        });
      }
      if (data.lambdaFunctionArn) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'lambdaFunctionArn is not applicable for webSearch target type',
          path: ['lambdaFunctionArn'],
        });
      }
      if (data.schemaSource) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'schemaSource is not applicable for webSearch target type',
          path: ['schemaSource'],
        });
      }
      if (data.httpRuntime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'httpRuntime is not applicable for webSearch target type',
          path: ['httpRuntime'],
        });
      }
      if (data.passthrough) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'passthrough is not applicable for webSearch target type',
          path: ['passthrough'],
        });
      }
      if (data.outboundAuth && data.outboundAuth.type !== 'NONE') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'outboundAuth is not applicable for webSearch target type (uses gateway IAM role)',
          path: ['outboundAuth'],
        });
      }
      if (data.connectorId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'connectorId is not applicable for webSearch target type',
          path: ['connectorId'],
        });
      }
      if (data.knowledgeBaseId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'knowledgeBaseId is not applicable for webSearch target type',
          path: ['knowledgeBaseId'],
        });
      }
      if (data.knowledgeBaseIds) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'knowledgeBaseIds is not applicable for webSearch target type',
          path: ['knowledgeBaseIds'],
        });
      }
    }
    if (data.targetType !== 'connector' && data.targetType !== 'webSearch') {
      if (data.connectorId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `connectorId only applies to connector target type`,
          path: ['connectorId'],
        });
      }
      if (data.knowledgeBaseId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `knowledgeBaseId only applies to connector target type`,
          path: ['knowledgeBaseId'],
        });
      }
      if (data.knowledgeBaseIds) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `knowledgeBaseIds only applies to connector target type`,
          path: ['knowledgeBaseIds'],
        });
      }
      if (data.excludeDomains) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `excludeDomains only applies to webSearch target type`,
          path: ['excludeDomains'],
        });
      }
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
    if (
      data.outboundAuth &&
      data.outboundAuth.type !== 'NONE' &&
      data.outboundAuth.type !== 'GATEWAY_IAM_ROLE' &&
      data.outboundAuth.type !== 'JWT_PASSTHROUGH' &&
      !data.outboundAuth.credentialName
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${data.outboundAuth.type} outbound auth requires a credentialName.`,
        path: ['outboundAuth', 'credentialName'],
      });
    }
    // GATEWAY_IAM_ROLE on passthrough requires service
    if (
      data.targetType === 'passthrough' &&
      data.outboundAuth?.type === 'GATEWAY_IAM_ROLE' &&
      !data.outboundAuth.service
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'GATEWAY_IAM_ROLE outbound auth on passthrough targets requires a service name.',
        path: ['outboundAuth', 'service'],
      });
    }
    // JWT_PASSTHROUGH is only valid for passthrough targets
    if (data.outboundAuth?.type === 'JWT_PASSTHROUGH' && data.targetType !== 'passthrough') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'JWT_PASSTHROUGH outbound auth is only valid for passthrough targets.',
        path: ['outboundAuth', 'type'],
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
export const GatewayProtocolTypeSchema = z.enum(['MCP', 'None']);
export type GatewayProtocolType = z.infer<typeof GatewayProtocolTypeSchema>;

export const AgentCoreGatewaySchema = z
  .object({
    name: GatewayNameSchema,
    /** Actual AWS resource name for imported gateways. When set, CDK uses this instead of generating projectName-name. */
    resourceName: GatewayNameSchema.optional(),
    /** Protocol type for this gateway. */
    protocolType: GatewayProtocolTypeSchema.optional(),
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
    /** ARN of an existing IAM execution role. When set, CDK uses this role instead of creating a new one. */
    executionRoleArn: z
      .string()
      .regex(/^arn:[^:]+:iam::\d{12}:role\/.+/, 'Must be a valid IAM role ARN')
      .max(2048)
      .optional(),
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
  )
  .superRefine((gw, ctx) => {
    // A protocolType: "None" (HTTP) gateway is a superset: it can host any target
    // type, including MCP targets (mcpServer, connector, KB, etc.). Only an MCP
    // gateway is restrictive — it cannot host the HTTP-only target types.
    for (const target of gw.targets) {
      if (gw.protocolType !== 'None' && NON_MCP_TARGET_TYPES.includes(target.targetType)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Target "${target.name}" is ${target.targetType} but gateway does not have protocolType: "None". Add --protocol-type None when creating the gateway.`,
        });
      }
    }
  });

export type AgentCoreGateway = z.infer<typeof AgentCoreGatewaySchema>;

// ============================================================================
// MCP Runtime Tool
// ============================================================================

/**
 * Binding from an MCP runtime tool to a runtime.
 * When present, the runtime is granted InvokeAgentRuntime permission
 * and receives the runtime ARN in the specified environment variable.
 */
export const McpRuntimeBindingSchema = z
  .object({
    runtimeName: z.string().min(1),
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
