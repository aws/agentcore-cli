import { NetworkModeSchema, NodeRuntimeSchema, PythonRuntimeSchema } from "./constants";
import type { DirectoryPath, FilePath } from "./types";
import { EnvVarNameSchema, GatewayNameSchema } from "./runtime";
import { GatewayAuthorizerConfigSchema, GatewayAuthorizerTypeSchema } from "./auth";
import { ToolDefinitionSchema } from "./mcp-defs";
import { TagsSchema } from "./tags";
import { z } from "zod";
export const GatewayTargetTypeSchema = z.enum([
  "lambda",
  "mcpServer",
  "openApiSchema",
  "smithyModel",
  "apiGateway",
  "lambdaFunctionArn",
  "httpRuntime",
  "connector",
  "passthrough",
]);
export type GatewayTargetType = z.infer<typeof GatewayTargetTypeSchema>;
export const NON_MCP_TARGET_TYPES: readonly GatewayTargetType[] = [
  "httpRuntime",
  "passthrough",
] as const;
export const MCP_TARGET_TYPES: readonly GatewayTargetType[] = [
  "lambda",
  "mcpServer",
  "openApiSchema",
  "smithyModel",
  "apiGateway",
  "lambdaFunctionArn",
] as const;
export const CONNECTOR_ID = {
  BEDROCK_KNOWLEDGE_BASES: "bedrock-knowledge-bases",
  WEB_SEARCH: "web-search",
} as const;
export const CONNECTOR_ID_VALUES = [
  CONNECTOR_ID.BEDROCK_KNOWLEDGE_BASES,
  CONNECTOR_ID.WEB_SEARCH,
] as const;
export const ConnectorIdSchema = z.enum(CONNECTOR_ID_VALUES);
export type ConnectorId = z.infer<typeof ConnectorIdSchema>;
export const REAL_KB_ID_PATTERN = /^[A-Z0-9]{10}$/;
export const OutboundAuthTypeSchema = z.enum([
  "OAUTH",
  "API_KEY",
  "NONE",
  "GATEWAY_IAM_ROLE",
  "JWT_PASSTHROUGH",
]);
export type OutboundAuthType = z.infer<typeof OutboundAuthTypeSchema>;
export const OutboundAuthSchema = z
  .object({
    type: OutboundAuthTypeSchema.default("NONE"),
    credentialName: z.string().min(1).optional(),
    scopes: z.array(z.string()).optional(),
    service: z.string().min(1).max(64).optional(),
    region: z.string().min(1).max(32).optional(),
  })
  .strict();
export type OutboundAuth = z.infer<typeof OutboundAuthSchema>;
export const TARGET_TYPE_AUTH_CONFIG: Record<
  GatewayTargetType,
  {
    authRequired: boolean;
    validAuthTypes: readonly OutboundAuthType[];
    iamRoleFallback: boolean;
  }
> = {
  openApiSchema: {
    authRequired: true,
    validAuthTypes: ["OAUTH", "API_KEY"],
    iamRoleFallback: false,
  },
  smithyModel: { authRequired: false, validAuthTypes: [], iamRoleFallback: true },
  apiGateway: { authRequired: false, validAuthTypes: ["API_KEY", "NONE"], iamRoleFallback: true },
  mcpServer: { authRequired: false, validAuthTypes: ["OAUTH", "NONE"], iamRoleFallback: false },
  lambda: { authRequired: false, validAuthTypes: ["OAUTH", "NONE"], iamRoleFallback: true },
  lambdaFunctionArn: {
    authRequired: false,
    validAuthTypes: ["OAUTH", "NONE"],
    iamRoleFallback: true,
  },
  httpRuntime: { authRequired: false, validAuthTypes: ["OAUTH", "NONE"], iamRoleFallback: true },
  connector: { authRequired: false, validAuthTypes: [], iamRoleFallback: true },
  passthrough: {
    authRequired: true,
    validAuthTypes: ["GATEWAY_IAM_ROLE", "OAUTH", "JWT_PASSTHROUGH"],
    iamRoleFallback: false,
  },
};
export const ApiGatewayHttpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
]);
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
export const McpImplLanguageSchema = z.enum(["TypeScript", "Python"]);
export type McpImplementationLanguage = z.infer<typeof McpImplLanguageSchema>;
export const ComputeHostSchema = z.enum(["Lambda", "AgentCoreRuntime"]);
export type ComputeHost = z.infer<typeof ComputeHostSchema>;
const DirectoryPathSchema = z.string().min(1) as unknown as z.ZodType<DirectoryPath>;
export const ToolImplementationBindingSchema = z
  .object({
    language: z.enum(["TypeScript", "Python"]),
    path: z.string().min(1),
    handler: z.string().min(1),
  })
  .strict();
export type ToolImplementationBinding = z.infer<typeof ToolImplementationBindingSchema>;
export const IamPolicyDocumentSchema = z
  .object({
    Version: z.string(),
    Statement: z.array(z.unknown()),
  })
  .passthrough();
export type IamPolicyDocument = z.infer<typeof IamPolicyDocumentSchema>;
const AgentRuntimeNameSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    "Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)",
  );
const PythonEntrypointSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-zA-Z0-9_][a-zA-Z0-9_/.-]*\.py(:[a-zA-Z_][a-zA-Z0-9_]*)?$/,
    'Must be a Python file path with optional handler (e.g., "main.py:agent" or "src/handler.py:app")',
  ) as unknown as z.ZodType<FilePath>;
const InstrumentationSchema = z.object({
  enableOtel: z.boolean().default(true),
});
const CodeZipRuntimeConfigSchema = z
  .object({
    artifact: z.literal("CodeZip"),
    pythonVersion: PythonRuntimeSchema,
    name: AgentRuntimeNameSchema,
    entrypoint: PythonEntrypointSchema,
    codeLocation: DirectoryPathSchema,
    instrumentation: InstrumentationSchema.optional(),
    networkMode: NetworkModeSchema.optional().default("PUBLIC"),
    description: z.string().optional(),
  })
  .strict();
export type CodeZipRuntimeConfig = z.infer<typeof CodeZipRuntimeConfigSchema>;
export const RuntimeConfigSchema = CodeZipRuntimeConfigSchema;
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
const LambdaComputeConfigSchema = z
  .object({
    host: z.literal("Lambda"),
    implementation: ToolImplementationBindingSchema,
    nodeVersion: NodeRuntimeSchema.optional(),
    pythonVersion: PythonRuntimeSchema.optional(),
    timeout: z.number().int().min(1).max(900).optional(),
    memorySize: z.number().int().min(128).max(10240).optional(),
    iamPolicy: IamPolicyDocumentSchema.optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.implementation.language === "TypeScript" && !data.nodeVersion) {
        return false;
      }
      if (data.implementation.language === "Python" && !data.pythonVersion) {
        return false;
      }
      return true;
    },
    {
      message:
        "TypeScript Lambda must specify nodeVersion, Python Lambda must specify pythonVersion",
    },
  );
export type LambdaComputeConfig = z.infer<typeof LambdaComputeConfigSchema>;
const AgentCoreRuntimeComputeConfigSchema = z
  .object({
    host: z.literal("AgentCoreRuntime"),
    implementation: ToolImplementationBindingSchema,
    runtime: RuntimeConfigSchema.optional(),
    iamPolicy: IamPolicyDocumentSchema.optional(),
  })
  .strict()
  .refine((data) => data.implementation.language === "Python", {
    message: "AgentCore Runtime only supports Python",
  });
export type AgentCoreRuntimeComputeConfig = z.infer<typeof AgentCoreRuntimeComputeConfigSchema>;
export const ToolComputeConfigSchema = z.discriminatedUnion("host", [
  LambdaComputeConfigSchema,
  AgentCoreRuntimeComputeConfigSchema,
]);
export type ToolComputeConfig = z.infer<typeof ToolComputeConfigSchema>;
const SchemaS3SourceSchema = z
  .object({
    uri: z.string().min(1).startsWith("s3://"),
    bucketOwnerAccountId: z.string().optional(),
  })
  .strict();
const SchemaInlineSourceSchema = z
  .object({
    path: z.string().min(1),
  })
  .strict();
export const SchemaSourceSchema = z.union([
  z.object({ inline: SchemaInlineSourceSchema }).strict(),
  z.object({ s3: SchemaS3SourceSchema }).strict(),
]);
export type SchemaSource = z.infer<typeof SchemaSourceSchema>;
export const HttpRuntimeConfigSchema = z
  .object({
    runtime: z.string().min(1),
    runtimeEndpoint: z.string().min(1).optional(),
  })
  .strict();
export type HttpRuntimeConfig = z.infer<typeof HttpRuntimeConfigSchema>;
export const StickinessConfigSchema = z
  .object({
    identifier: z.string().min(1).max(256),
    timeout: z.number().int().min(1).max(86400).optional(),
  })
  .strict();
export type StickinessConfig = z.infer<typeof StickinessConfigSchema>;
export const PassthroughProtocolTypeSchema = z.enum(["MCP", "A2A", "INFERENCE", "CUSTOM"]);
export type PassthroughProtocolType = z.infer<typeof PassthroughProtocolTypeSchema>;
export const PassthroughConfigSchema = z
  .object({
    endpoint: z
      .string()
      .min(1)
      .regex(/^https:\/\/[a-zA-Z0-9\-.]+(:[0-9]{1,5})?(\/.*)?$/, "Must be a valid HTTPS URL"),
    protocolType: PassthroughProtocolTypeSchema.default("CUSTOM"),
    stickinessConfiguration: StickinessConfigSchema.optional(),
  })
  .strict();
export type PassthroughConfig = z.infer<typeof PassthroughConfigSchema>;
const TARGET_CONFIGURATION_FIELDS = [
  "toolDefinitions",
  "compute",
  "endpoint",
  "outboundAuth",
  "apiGateway",
  "schemaSource",
  "lambdaFunctionArn",
  "httpRuntime",
  "connectorId",
  "configurations",
  "passthrough",
] as const;
type TargetConfigurationField = (typeof TARGET_CONFIGURATION_FIELDS)[number];
const ALLOWED_TARGET_CONFIGURATION_FIELDS: Record<
  GatewayTargetType,
  readonly TargetConfigurationField[]
> = {
  lambda: ["toolDefinitions", "compute", "outboundAuth"],
  mcpServer: ["toolDefinitions", "compute", "endpoint", "outboundAuth"],
  openApiSchema: ["schemaSource", "outboundAuth"],
  smithyModel: ["schemaSource"],
  apiGateway: ["apiGateway", "outboundAuth"],
  lambdaFunctionArn: ["lambdaFunctionArn"],
  httpRuntime: ["httpRuntime", "outboundAuth"],
  connector: ["connectorId", "configurations"],
  passthrough: ["passthrough", "outboundAuth"],
};
const REQUIRED_TARGET_CONFIGURATION_FIELDS: Partial<
  Record<GatewayTargetType, readonly TargetConfigurationField[]>
> = {
  lambda: ["toolDefinitions", "compute"],
  openApiSchema: ["schemaSource"],
  smithyModel: ["schemaSource"],
  apiGateway: ["apiGateway"],
  lambdaFunctionArn: ["lambdaFunctionArn"],
  httpRuntime: ["httpRuntime"],
  connector: ["connectorId"],
  passthrough: ["passthrough"],
};
export const AgentCoreGatewayTargetSchema = z
  .object({
    name: z.string().min(1),
    targetType: GatewayTargetTypeSchema,
    toolDefinitions: z.array(ToolDefinitionSchema).optional(),
    compute: ToolComputeConfigSchema.optional(),
    endpoint: z.string().url().optional(),
    outboundAuth: OutboundAuthSchema.optional(),
    apiGateway: ApiGatewayConfigSchema.optional(),
    schemaSource: SchemaSourceSchema.optional(),
    lambdaFunctionArn: LambdaFunctionArnConfigSchema.optional(),
    httpRuntime: HttpRuntimeConfigSchema.optional(),
    connectorId: ConnectorIdSchema.optional(),
    configurations: z
      .array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          parameterValues: z.record(z.string(), z.unknown()).optional(),
          parameterOverrides: z
            .array(
              z.object({
                path: z.string(),
                description: z.string().optional(),
                visible: z.boolean().optional(),
              }),
            )
            .optional(),
        }),
      )
      .optional(),
    passthrough: PassthroughConfigSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const allowedFields = ALLOWED_TARGET_CONFIGURATION_FIELDS[data.targetType];
    for (const field of TARGET_CONFIGURATION_FIELDS) {
      if (data[field] !== undefined && !allowedFields.includes(field)) {
        ctx.addIssue({
          code: "custom",
          message: `${field} is not applicable for ${data.targetType} target type`,
          path: [field],
        });
      }
    }
    for (const field of REQUIRED_TARGET_CONFIGURATION_FIELDS[data.targetType] ?? []) {
      const value = data[field];
      if (value === undefined || (Array.isArray(value) && value.length === 0)) {
        ctx.addIssue({
          code: "custom",
          message: `${field} is required for ${data.targetType} target type`,
          path: [field],
        });
      }
    }
    if (data.targetType === "mcpServer" && !data.compute && !data.endpoint) {
      ctx.addIssue({
        code: "custom",
        message: "MCP Server targets require either an endpoint URL or compute configuration.",
      });
    }
    const authConfig = TARGET_TYPE_AUTH_CONFIG[data.targetType];
    const authType = data.outboundAuth?.type ?? "NONE";
    if (allowedFields.includes("outboundAuth")) {
      if (authConfig.authRequired && authType === "NONE") {
        ctx.addIssue({
          code: "custom",
          message: `${data.targetType} targets require outbound auth (${authConfig.validAuthTypes.join(" or ")})`,
          path: ["outboundAuth"],
        });
      }
      if (authType !== "NONE" && !authConfig.validAuthTypes.includes(authType)) {
        ctx.addIssue({
          code: "custom",
          message: `${data.targetType} targets do not support ${authType} outbound auth`,
          path: ["outboundAuth"],
        });
      }
      if (
        data.outboundAuth &&
        data.outboundAuth.type !== "NONE" &&
        data.outboundAuth.type !== "GATEWAY_IAM_ROLE" &&
        data.outboundAuth.type !== "JWT_PASSTHROUGH" &&
        !data.outboundAuth.credentialName
      ) {
        ctx.addIssue({
          code: "custom",
          message: `${data.outboundAuth.type} outbound auth requires a credentialName.`,
          path: ["outboundAuth", "credentialName"],
        });
      }
      if (
        data.outboundAuth?.type === "GATEWAY_IAM_ROLE" &&
        data.targetType === "passthrough" &&
        !data.outboundAuth.service
      ) {
        ctx.addIssue({
          code: "custom",
          message: "GATEWAY_IAM_ROLE outbound auth on passthrough targets requires a service name.",
          path: ["outboundAuth", "service"],
        });
      }
    }
  });
export type AgentCoreGatewayTarget = z.infer<typeof AgentCoreGatewayTargetSchema>;
export const GatewayExceptionLevelSchema = z.enum(["NONE", "DEBUG"]);
export type GatewayExceptionLevel = z.infer<typeof GatewayExceptionLevelSchema>;
export const PolicyEngineModeSchema = z.enum(["LOG_ONLY", "ENFORCE"]);
export type PolicyEngineMode = z.infer<typeof PolicyEngineModeSchema>;
export const GatewayPolicyEngineConfigurationSchema = z
  .object({
    policyEngineName: z.string().min(1),
    mode: PolicyEngineModeSchema,
  })
  .strict();
export type GatewayPolicyEngineConfiguration = z.infer<
  typeof GatewayPolicyEngineConfigurationSchema
>;
export const GatewayProtocolTypeSchema = z.enum(["MCP", "None"]);
export type GatewayProtocolType = z.infer<typeof GatewayProtocolTypeSchema>;
export const AgentCoreGatewaySchema = z
  .object({
    name: GatewayNameSchema,
    resourceName: GatewayNameSchema.optional(),
    protocolType: GatewayProtocolTypeSchema.optional(),
    description: z.string().optional(),
    targets: z.array(AgentCoreGatewayTargetSchema),
    authorizerType: GatewayAuthorizerTypeSchema.default("NONE"),
    authorizerConfiguration: GatewayAuthorizerConfigSchema.optional(),
    enableSemanticSearch: z.boolean().default(true),
    exceptionLevel: GatewayExceptionLevelSchema.default("NONE"),
    policyEngineConfiguration: GatewayPolicyEngineConfigurationSchema.optional(),
    executionRoleArn: z
      .string()
      .regex(/^arn:[^:]+:iam::\d{12}:role\/.+/, "Must be a valid IAM role ARN")
      .max(2048)
      .optional(),
    tags: TagsSchema.optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.authorizerType === "CUSTOM_JWT") {
        return data.authorizerConfiguration?.customJwtAuthorizer !== undefined;
      }
      return true;
    },
    {
      message: "customJwtAuthorizer configuration is required when authorizerType is CUSTOM_JWT",
      path: ["authorizerConfiguration"],
    },
  )
  .superRefine((gw, ctx) => {
    for (const target of gw.targets) {
      if (gw.protocolType !== "None" && NON_MCP_TARGET_TYPES.includes(target.targetType)) {
        ctx.addIssue({
          code: "custom",
          message: `Target "${target.name}" is ${target.targetType} but the Gateway does not have protocolType: "None"`,
        });
      }
    }
  });
export type AgentCoreGateway = z.infer<typeof AgentCoreGatewaySchema>;
export const McpRuntimeBindingSchema = z
  .object({
    runtimeName: z.string().min(1),
    envVarName: EnvVarNameSchema,
  })
  .strict();
export type McpRuntimeBinding = z.infer<typeof McpRuntimeBindingSchema>;
export const AgentCoreMcpRuntimeToolSchema = z
  .object({
    name: z.string().min(1),
    toolDefinition: ToolDefinitionSchema,
    compute: AgentCoreRuntimeComputeConfigSchema,
    bindings: z.array(McpRuntimeBindingSchema).optional(),
  })
  .strict();
export type AgentCoreMcpRuntimeTool = z.infer<typeof AgentCoreMcpRuntimeToolSchema>;
