import { NetworkModeSchema } from '../../constants';
import { NetworkConfigSchema } from '../agent-env';
import { LifecycleConfigurationSchema } from '../agent-env';
import { AuthorizerConfigSchema, RuntimeAuthorizerTypeSchema } from '../auth';
import { uniqueBy } from '../zod-util';
import { TagsSchema } from './tags';
import { z } from 'zod';

// ============================================================================
// Harness Name
// ============================================================================

export const HarnessNameSchema = z
  .string()
  .min(1, 'Harness name is required')
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

// ============================================================================
// Model Configuration
// ============================================================================

export const HarnessModelProviderSchema = z.enum(['bedrock', 'open_ai', 'gemini']);
export type HarnessModelProvider = z.infer<typeof HarnessModelProviderSchema>;

export const HarnessModelSchema = z
  .object({
    provider: HarnessModelProviderSchema,
    modelId: z.string().min(1, 'Model ID is required'),
    apiKeyArn: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    topK: z.number().min(0).max(1).optional(),
    maxTokens: z.number().int().min(1).optional(),
  })
  .superRefine((model, ctx) => {
    if (model.topK !== undefined && model.provider !== 'gemini') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'topK is only supported for the "gemini" provider',
        path: ['topK'],
      });
    }
  });

export type HarnessModel = z.infer<typeof HarnessModelSchema>;

// ============================================================================
// Tool Configuration
// ============================================================================

export const HarnessToolTypeSchema = z.enum([
  'remote_mcp',
  'agentcore_browser',
  'agentcore_gateway',
  'inline_function',
  'agentcore_code_interpreter',
]);
export type HarnessToolType = z.infer<typeof HarnessToolTypeSchema>;

export const HarnessToolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    'Tool name must contain only alphanumeric characters, hyphens, and underscores (1-64 chars)'
  );

export const RemoteMcpConfigSchema = z.object({
  remoteMcp: z.object({
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
  }),
});

export const AgentCoreBrowserConfigSchema = z.object({
  agentCoreBrowser: z.object({
    browserArn: z.string().optional(),
  }),
});

export const AgentCoreCodeInterpreterConfigSchema = z.object({
  agentCoreCodeInterpreter: z.object({
    codeInterpreterArn: z.string().optional(),
  }),
});

export const GatewayOAuthGrantTypeSchema = z.enum(['CLIENT_CREDENTIALS', 'USER_FEDERATION']);

export const HarnessGatewayOutboundAuthSchema = z.union([
  z.object({ awsIam: z.object({}) }),
  z.object({ none: z.object({}) }),
  z.object({
    oauth: z.object({
      providerArn: z.string().min(1),
      scopes: z.array(z.string().min(1)),
      grantType: GatewayOAuthGrantTypeSchema.optional(),
      customParameters: z.record(z.string(), z.string()).optional(),
    }),
  }),
]);

export type HarnessGatewayOutboundAuth = z.infer<typeof HarnessGatewayOutboundAuthSchema>;

export const AgentCoreGatewayConfigSchema = z.object({
  agentCoreGateway: z
    .object({
      gatewayArn: z.string().min(1),
      outboundAuth: HarnessGatewayOutboundAuthSchema.optional(),
    })
    .passthrough()
    .superRefine((data, ctx) => {
      if ('credentialProviderName' in data) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'credentialProviderName is no longer supported. Use outboundAuth instead. Example: outboundAuth: { awsIam: {} } or outboundAuth: { oauth: { providerArn: "...", scopes: [...] } }',
          path: ['credentialProviderName'],
        });
      }
    }),
});

export const InlineFunctionConfigSchema = z.object({
  inlineFunction: z.object({
    description: z.string().min(1),
    inputSchema: z.record(z.string(), z.unknown()),
  }),
});

export const HarnessToolConfigSchema = z.union([
  RemoteMcpConfigSchema,
  AgentCoreBrowserConfigSchema,
  AgentCoreCodeInterpreterConfigSchema,
  AgentCoreGatewayConfigSchema,
  InlineFunctionConfigSchema,
]);

const TOOL_TYPE_TO_CONFIG_KEY: Record<HarnessToolType, string> = {
  remote_mcp: 'remoteMcp',
  agentcore_browser: 'agentCoreBrowser',
  agentcore_gateway: 'agentCoreGateway',
  inline_function: 'inlineFunction',
  agentcore_code_interpreter: 'agentCoreCodeInterpreter',
};

const TOOL_TYPES_REQUIRING_CONFIG = new Set<HarnessToolType>(['remote_mcp', 'agentcore_gateway', 'inline_function']);

export const HarnessToolSchema = z
  .object({
    type: HarnessToolTypeSchema,
    name: HarnessToolNameSchema,
    config: HarnessToolConfigSchema.optional(),
  })
  .superRefine((tool, ctx) => {
    const expectedKey = TOOL_TYPE_TO_CONFIG_KEY[tool.type];

    if (!tool.config) {
      if (TOOL_TYPES_REQUIRING_CONFIG.has(tool.type)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Tool type "${tool.type}" requires a "${expectedKey}" config`,
          path: ['config'],
        });
      }
      return;
    }

    const configKeys = Object.keys(tool.config);
    if (configKeys.length !== 1 || configKeys[0] !== expectedKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Tool type "${tool.type}" requires "${expectedKey}" config, got "${configKeys[0]}"`,
        path: ['config'],
      });
    }
  });

export type HarnessTool = z.infer<typeof HarnessToolSchema>;

// ============================================================================
// Memory Reference
// ============================================================================

export const HarnessMemoryRefSchema = z.object({
  name: z.string().min(1).optional(),
  arn: z.string().min(1).optional(),
  actorId: z.string().optional(),
});

export type HarnessMemoryRef = z.infer<typeof HarnessMemoryRefSchema>;

// ============================================================================
// Truncation Configuration
// ============================================================================

export const HarnessTruncationStrategySchema = z.enum(['sliding_window', 'summarization']);

export const SlidingWindowConfigSchema = z.object({
  slidingWindow: z.object({
    messagesCount: z.number().int().min(1).optional(),
  }),
});

export const SummarizationConfigSchema = z.object({
  summarization: z.object({
    summaryRatio: z.number().min(0).max(1).optional(),
    preserveRecentMessages: z.number().int().min(0).optional(),
    summarizationSystemPrompt: z.string().optional(),
  }),
});

export const HarnessTruncationConfigSchema = z.object({
  strategy: HarnessTruncationStrategySchema,
  config: z.union([SlidingWindowConfigSchema, SummarizationConfigSchema]).optional(),
});

export type HarnessTruncationConfig = z.infer<typeof HarnessTruncationConfigSchema>;

// ============================================================================
// Allowed Tools
// ============================================================================

export const AllowedToolSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(\*|@?[^/]+(\/[^/]+)?)$/, 'Must be "*" or a tool name pattern (max 64 chars)');

// ============================================================================
// HarnessSpec — per-harness config file schema (harness.json)
// ============================================================================

export const HarnessSpecSchema = z
  .object({
    name: HarnessNameSchema,
    model: HarnessModelSchema,
    systemPrompt: z.string().optional(),
    tools: z
      .array(HarnessToolSchema)
      .default([])
      .superRefine(
        uniqueBy(
          tool => tool.name,
          name => `Duplicate tool name: ${name}`
        )
      ),
    skills: z.array(z.string().min(1)).default([]),
    allowedTools: z.array(AllowedToolSchema).optional(),
    memory: HarnessMemoryRefSchema.optional(),
    maxIterations: z.number().int().min(1).optional(),
    maxTokens: z.number().int().min(1).optional(),
    timeoutSeconds: z.number().int().min(1).optional(),
    truncation: HarnessTruncationConfigSchema.optional(),
    containerUri: z.string().min(1).optional(),
    dockerfile: z.string().min(1).optional(),
    executionRoleArn: z.string().optional(),
    networkMode: NetworkModeSchema.optional(),
    networkConfig: NetworkConfigSchema.optional(),
    lifecycleConfig: LifecycleConfigurationSchema.optional(),
    sessionStoragePath: z
      .string()
      .min(1)
      .refine(val => val.startsWith('/mnt/'), { message: 'sessionStoragePath must be an absolute path under /mnt/' })
      .optional(),
    environmentVariables: z.record(z.string(), z.string()).optional(),
    /** Authorizer type for inbound requests. Defaults to AWS_IAM. */
    authorizerType: RuntimeAuthorizerTypeSchema.optional(),
    /** Authorizer configuration. Required when authorizerType is CUSTOM_JWT. */
    authorizerConfiguration: AuthorizerConfigSchema.optional(),
    tags: TagsSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.containerUri !== undefined && data.dockerfile !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'containerUri and dockerfile are mutually exclusive',
        path: ['containerUri'],
      });
    }
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

export type HarnessSpec = z.infer<typeof HarnessSpecSchema>;
