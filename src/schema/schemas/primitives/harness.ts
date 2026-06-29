import { NetworkModeSchema } from '../../constants';
import {
  EfsAccessPointConfigSchema,
  LifecycleConfigurationSchema,
  NetworkConfigSchema,
  S3FilesAccessPointConfigSchema,
  SessionStorageSchema,
} from '../agent-env';
import { AuthorizerConfigSchema, RuntimeAuthorizerTypeSchema } from '../auth';
import { ConnectionSchema } from '../connections';
import { uniqueBy } from '../zod-util';
import { TagsSchema } from './tags';
import { z } from 'zod';

/**
 * ECR container image URI pattern, mirroring the CFN ContainerConfiguration.ContainerUri
 * constraint (private 12-digit ECR registry or public.ecr.aws, optional tag/digest).
 * A non-ECR URI is rejected client-side instead of failing at CloudFormation CREATE.
 */
export const CONTAINER_URI_PATTERN =
  // eslint-disable-next-line security/detect-unsafe-regex -- mirrors the CFN ContainerUri pattern; input is length-bounded by .max(MAX_CONTAINER_URI_LENGTH)
  /^(([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?|public\.ecr\.aws)\/((?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*)(?::([^:@]{1,300}))?(?:@(.+))?$/;
/** CFN ContainerConfiguration.ContainerUri maxLength. */
export const MAX_CONTAINER_URI_LENGTH = 1024;
/** CFN EnvironmentVariables value maxLength and map maxProperties. */
export const MAX_ENV_VAR_VALUE_LENGTH = 5000;
export const MAX_ENV_VARS = 50;
/** CFN/Smithy EnvironmentVariableKey length bounds (Smithy EnvironmentVariableKey: 1–100, no char pattern). */
export const MAX_ENV_VAR_KEY_LENGTH = 100;

// ============================================================================
// Harness Name
// ============================================================================

export const HarnessNameSchema = z
  .string()
  .min(1, 'Harness name is required')
  .max(40)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 40 chars)'
  );

// ============================================================================
// Model Configuration
// ============================================================================

export const HarnessModelProviderSchema = z.enum(['bedrock', 'open_ai', 'gemini', 'lite_llm']);
export type HarnessModelProvider = z.infer<typeof HarnessModelProviderSchema>;

/** Max length of the LiteLLM apiBase URL (Smithy: HarnessLiteLlmApiBase, 1–16383). */
export const MAX_LITE_LLM_API_BASE_LENGTH = 16383;

export const BedrockApiFormatSchema = z.enum(['converse_stream', 'responses', 'chat_completions']);
export type BedrockApiFormat = z.infer<typeof BedrockApiFormatSchema>;

export const OpenAiApiFormatSchema = z.enum(['responses', 'chat_completions']);
export type OpenAiApiFormat = z.infer<typeof OpenAiApiFormatSchema>;

export const HarnessApiFormatSchema = z.enum(['converse_stream', 'responses', 'chat_completions']);
export type HarnessApiFormat = z.infer<typeof HarnessApiFormatSchema>;

export const HarnessModelSchema = z
  .object({
    provider: HarnessModelProviderSchema,
    modelId: z.string().min(1, 'Model ID is required'),
    apiKeyArn: z.string().optional(),
    apiFormat: HarnessApiFormatSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    topK: z.number().int().min(0).max(500).optional(),
    maxTokens: z.number().int().min(1).optional(),
    /** LiteLLM only: base URL for the third-party model provider's API endpoint. */
    apiBase: z.string().min(1).max(MAX_LITE_LLM_API_BASE_LENGTH).optional(),
    /** LiteLLM only: provider-specific parameters passed through to the model provider unchanged. */
    additionalParams: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((model, ctx) => {
    if (model.topK !== undefined && model.provider !== 'gemini') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'topK is only supported for the "gemini" provider',
        path: ['topK'],
      });
    }
    if (model.apiFormat !== undefined) {
      if (model.provider !== 'bedrock' && model.provider !== 'open_ai') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '--api-format is only supported for bedrock and open_ai providers',
          path: ['apiFormat'],
        });
      } else if (model.provider === 'open_ai' && model.apiFormat === 'converse_stream') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid API format for open_ai: ${model.apiFormat}. Use ${OpenAiApiFormatSchema.options.join(', ')}`,
          path: ['apiFormat'],
        });
      }
    }
    // CFN requires ApiKeyArn for the open_ai and gemini model configs (bedrock and lite_llm do not).
    if (model.apiKeyArn === undefined && (model.provider === 'open_ai' || model.provider === 'gemini')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `apiKeyArn is required for the "${model.provider}" provider`,
        path: ['apiKeyArn'],
      });
    }
    if (model.apiBase !== undefined && model.provider !== 'lite_llm') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'apiBase is only supported for the "lite_llm" provider',
        path: ['apiBase'],
      });
    }
    if (model.additionalParams !== undefined && model.provider !== 'lite_llm') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'additionalParams is only supported for the "lite_llm" provider',
        path: ['additionalParams'],
      });
    }
  });

export type HarnessModel = z.infer<typeof HarnessModelSchema>;

export function validateApiFormat(
  apiFormat: string,
  provider: string
): { valid: true } | { valid: false; error: string } {
  const allFormats = HarnessApiFormatSchema.options as readonly string[];
  if (!allFormats.includes(apiFormat)) {
    return { valid: false, error: `Invalid API format: ${apiFormat}. Use ${allFormats.join(', ')}` };
  }
  if (provider !== 'bedrock' && provider !== 'open_ai') {
    return { valid: false, error: '--api-format is only supported for bedrock and open_ai providers' };
  }
  const result = HarnessModelSchema.safeParse({ provider, modelId: 'placeholder', apiFormat });
  if (result.success) return { valid: true };
  const apiFormatIssue = result.error.issues.find(i => i.path.includes('apiFormat'));
  if (apiFormatIssue) {
    return {
      valid: false,
      error: `Invalid API format for ${provider}: ${apiFormat}. Use ${(provider === 'open_ai' ? OpenAiApiFormatSchema : BedrockApiFormatSchema).options.join(', ')}`,
    };
  }
  return { valid: true };
}

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

/**
 * Per-namespace retrieval tuning, applied as a flat default across every namespace
 * of the referenced memory's strategies. Namespaces are only known at CDK synth
 * (from the resolved Memory's strategies), so a per-namespace map cannot be authored
 * here; the CDK fans this single config out to each namespace. StrategyId is omitted
 * deliberately — the namespace already identifies the strategy and the id is
 * service-assigned. Maps to CFN HarnessAgentCoreMemoryRetrievalConfig {TopK, RelevanceScore}.
 */
export const HarnessMemoryRetrievalConfigSchema = z
  .object({
    topK: z.number().int().min(1).optional(),
    relevanceScore: z.number().min(0).max(1).optional(),
  })
  .strict()
  // An empty `{}` parses against the optional fields, but fans out to per-namespace `{}` objects —
  // the exact shape that crashed the pre-v6 service handler. Require at least one knob.
  .refine(v => v.topK !== undefined || v.relevanceScore !== undefined, {
    message: 'retrievalConfig must specify at least one of topK or relevanceScore',
  });

export type HarnessMemoryRetrievalConfig = z.infer<typeof HarnessMemoryRetrievalConfigSchema>;

/**
 * Managed-memory strategy set. NOT MemoryStrategyTypeSchema: managed harness memory excludes
 * CUSTOM (the CFN ManagedMemoryConfiguration.Strategies enum is exactly these four).
 */
export const ManagedMemoryStrategySchema = z.enum(['SEMANTIC', 'SUMMARIZATION', 'USER_PREFERENCE', 'EPISODIC']);

/**
 * Managed: the harness creates and owns its memory internally. The memory `arn` is read-only
 * (service-populated) and never authored here. `strategies` is OPTIONAL and left absent by default:
 * when omitted, the harness/service applies its own default strategy set. It is only written when the
 * user explicitly tunes it, so the CLI never pins a default the service might evolve.
 */
const ManagedMemoryRefSchema = z
  .object({
    mode: z.literal('managed'),
    strategies: z.array(ManagedMemoryStrategySchema).min(1).max(4).optional(),
    eventExpiryDuration: z.number().int().min(3).max(365).optional(),
    encryptionKeyArn: z.string().min(1).optional(),
  })
  .strict();

/**
 * Existing (bring-your-own): reference a memory by name (project sibling) or arn, carrying the
 * optional deploy-time tuning. This is the pre-union flat shape, now tagged `existing`.
 */
const ExistingMemoryRefSchema = z
  .object({
    mode: z.literal('existing'),
    name: z.string().min(1).optional(),
    arn: z.string().min(1).optional(),
    actorId: z.string().optional(),
    /** Limits how many recent memory messages are loaded into context (CFN MessagesCount). */
    messagesCount: z.number().int().min(1).optional(),
    /** Retrieval tuning applied to every namespace of the referenced memory (CFN RetrievalConfig). */
    retrievalConfig: HarnessMemoryRetrievalConfigSchema.optional(),
  })
  // .strict() so a typo (e.g. `messageCount` for `messagesCount`) is a parse error rather than a
  // silently-dropped field that defeats the B6 MessagesCount fix.
  .strict()
  .refine(m => m.arn != null || m.name != null, {
    message: 'existing memory requires `arn` or `name`',
    path: ['name'],
  })
  .superRefine((ref, ctx) => {
    // retrievalConfig is applied per-namespace, and namespaces are only resolvable from a by-name
    // memory's strategies. At synth `arn` takes precedence over `name` (resolveHarnessMemory), so
    // ANY ref carrying `arn` resolves no strategies and buildRetrievalConfig drops the tuning —
    // including the `{ arn, name, retrievalConfig }` combo. Gate on `arn` alone, not `arn && !name`,
    // so that combo can't slip through. (messagesCount and actorId are emitted directly from the
    // ref, so they stay valid for a by-arn reference.)
    if (ref.arn && ref.retrievalConfig !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'retrievalConfig is not supported when memory is referenced by `arn` (per-namespace tuning is only resolvable for a by-name reference). Reference the memory by `name` only, or drop retrievalConfig.',
        path: ['retrievalConfig'],
      });
    }
  });

/** Disabled: explicit opt-out of memory. */
const DisabledMemoryRefSchema = z.object({ mode: z.literal('disabled') }).strict();

/**
 * Memory reference for a harness — exactly one of managed | existing | disabled.
 * A legacy-aware preprocess maps the pre-union flat shape ({ name | arn | ... }) to the `existing`
 * arm. Absent memory STAYS absent — managed is the default only for NEW harnesses (seeded at create
 * time by the CLI/TUI), never invented here, so already-deployed harnesses are not auto-upgraded.
 */
export const HarnessMemoryRefSchema = z.preprocess(
  val => {
    if (val == null || typeof val !== 'object') return val;
    const obj = val as Record<string, unknown>;
    if ('mode' in obj) return obj; // already union-tagged
    // Legacy flat shape → existing (it always referenced a sibling/external memory by name or arn).
    return { mode: 'existing', ...obj };
  },
  z.discriminatedUnion('mode', [ManagedMemoryRefSchema, ExistingMemoryRefSchema, DisabledMemoryRefSchema])
);

export type HarnessMemoryRef = z.infer<typeof HarnessMemoryRefSchema>;
export type ManagedMemoryStrategy = z.infer<typeof ManagedMemoryStrategySchema>;

// ============================================================================
// Truncation Configuration
// ============================================================================

export const HarnessTruncationStrategySchema = z.enum(['sliding_window', 'summarization', 'none']);

// .strict() on the outer object so a payload carrying BOTH arms
// (`{ slidingWindow: {...}, summarization: {...} }`) fails the union — without it the union
// matches the first arm and silently drops the second arm's config.
export const SlidingWindowConfigSchema = z
  .object({
    slidingWindow: z.object({
      messagesCount: z.number().int().min(1).optional(),
    }),
  })
  .strict();

export const SummarizationConfigSchema = z
  .object({
    summarization: z.object({
      summaryRatio: z.number().min(0).max(1).optional(),
      preserveRecentMessages: z.number().int().min(0).optional(),
      summarizationSystemPrompt: z.string().optional(),
    }),
  })
  .strict();

export const HarnessTruncationConfigSchema = z
  .object({
    strategy: HarnessTruncationStrategySchema,
    config: z.union([SlidingWindowConfigSchema, SummarizationConfigSchema]).optional(),
  })
  .superRefine((data, ctx) => {
    // Bind the config arm to the chosen strategy: sliding_window must carry a slidingWindow
    // config (or none), summarization a summarization config (or none), and none takes no config.
    if (!data.config) return;
    const configKey = 'slidingWindow' in data.config ? 'slidingWindow' : 'summarization';
    const expected: Record<typeof data.strategy, string | undefined> = {
      sliding_window: 'slidingWindow',
      summarization: 'summarization',
      none: undefined,
    };
    if (expected[data.strategy] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Truncation strategy "${data.strategy}" does not take a config`,
        path: ['config'],
      });
    } else if (expected[data.strategy] !== configKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Truncation strategy "${data.strategy}" requires a "${expected[data.strategy]}" config, got "${configKey}"`,
        path: ['config'],
      });
    }
  });

export type HarnessTruncationConfig = z.infer<typeof HarnessTruncationConfigSchema>;

// ============================================================================
// Skill Configuration
// ============================================================================

export const HarnessSkillGitAuthSchema = z.object({
  credentialName: z.string().min(1),
  username: z.string().optional(),
});

export type HarnessSkillGitAuth = z.infer<typeof HarnessSkillGitAuthSchema>;

export const HarnessSkillS3SourceSchema = z
  .object({
    s3Uri: z
      .string()
      .min(5)
      .regex(/^s3:\/\//, 'Must be an S3 URI starting with s3://'),
  })
  .strict();

export type HarnessSkillS3Source = z.infer<typeof HarnessSkillS3SourceSchema>;

export const HarnessSkillGitSourceSchema = z
  .object({
    gitUrl: z
      .string()
      .min(8)
      .regex(/^https:\/\//, 'Must be an HTTPS git URL'),
    path: z.string().min(1).optional(),
    auth: HarnessSkillGitAuthSchema.optional(),
  })
  .strict();

export type HarnessSkillGitSource = z.infer<typeof HarnessSkillGitSourceSchema>;

export const HarnessSkillPathSourceSchema = z
  .object({
    path: z.string().min(1),
  })
  .strict();

export type HarnessSkillPathSource = z.infer<typeof HarnessSkillPathSourceSchema>;

export const HarnessSkillAwsSkillsSourceSchema = z
  .object({
    awsSkills: z
      .object({
        paths: z.array(z.string().min(1).max(4096)).optional(),
      })
      .strict(),
  })
  .strict();

export type HarnessSkillAwsSkillsSource = z.infer<typeof HarnessSkillAwsSkillsSourceSchema>;

export const HarnessSkillSchema = z.union([
  z
    .string()
    .min(1)
    .transform(path => ({ path })),
  HarnessSkillS3SourceSchema,
  HarnessSkillGitSourceSchema,
  HarnessSkillPathSourceSchema,
  HarnessSkillAwsSkillsSourceSchema,
]);

export type HarnessSkillInput = z.input<typeof HarnessSkillSchema>;
export type HarnessSkill = z.output<typeof HarnessSkillSchema>;

// ============================================================================
// Allowed Tools
// ============================================================================

export const AllowedToolSchema = z
  .string()
  .min(1)
  .max(64)
  // eslint-disable-next-line security/detect-unsafe-regex -- safe: input is bounded to 64 chars by .max(64)
  .regex(/^(\*|@?[^/]+(\/[^/]+)?)$/, 'Must be "*" or a tool name pattern (max 64 chars)');

/**
 * Detects the legacy file-path-shaped `systemPrompt` (the pre-migration `./prompt.md` style that
 * the old L3 read from disk). A real system prompt is instructional prose containing whitespace;
 * the legacy shape was always a single bare token that is a relative path or ends in .md/.txt.
 * Used to fail fast on upgrade rather than silently shipping the path string as the prompt text.
 */
export function looksLikeLegacyPromptPath(value: string): boolean {
  const v = value.trim();
  if (!/^\S+$/.test(v)) return false; // prose contains whitespace — never a path
  return /^\.\.?\//.test(v) || /\.(md|txt)$/i.test(v);
}

// ============================================================================
// HarnessSpec — per-harness config file schema (harness.json)
// ============================================================================

export const HarnessSpecSchema = z
  .object({
    name: HarnessNameSchema,
    model: HarnessModelSchema,
    // Always literal text. CFN HarnessSystemContentBlock.Text is minLength:1, so a blank or
    // whitespace-only prompt would deploy to CREATE_FAILED — reject it client-side instead.
    // (File-backed prompts are supplied via system-prompt.md auto-discovery, not this field.)
    systemPrompt: z
      .string()
      .refine(val => val.trim().length > 0, { message: 'systemPrompt must not be empty or whitespace-only' })
      // Migration fail-fast: the previous L3 treated a `./prompt.md`-style value as a file path and
      // loaded its contents; this field is now ALWAYS literal text, so such a value would silently
      // ship as the prompt itself. Reject the legacy file-path shape so the divergence fails loudly
      // at parse/validate time (before synth) instead of in production.
      .refine(val => !looksLikeLegacyPromptPath(val), {
        message:
          'systemPrompt looks like a file path. It is now always literal text — put file-backed prompts in a `system-prompt.md` in the harness directory (auto-discovered), or inline the prompt text here.',
      })
      .optional(),
    tools: z
      .array(HarnessToolSchema)
      .default([])
      .superRefine(
        uniqueBy(
          tool => tool.name,
          name => `Duplicate tool name: ${name}`
        )
      ),
    skills: z.array(HarnessSkillSchema).default([]),
    allowedTools: z.array(AllowedToolSchema).optional(),
    memory: HarnessMemoryRefSchema.optional(),
    maxIterations: z.number().int().min(1).optional(),
    maxTokens: z.number().int().min(1).optional(),
    timeoutSeconds: z.number().int().min(1).optional(),
    truncation: HarnessTruncationConfigSchema.optional(),
    containerUri: z
      .string()
      .min(1)
      .max(MAX_CONTAINER_URI_LENGTH)
      .regex(CONTAINER_URI_PATTERN, 'containerUri must be an ECR image URI (12-digit private ECR or public.ecr.aws)')
      .optional(),
    dockerfile: z.string().min(1).optional(),
    executionRoleArn: z.string().optional(),
    networkMode: NetworkModeSchema.optional(),
    networkConfig: NetworkConfigSchema.optional(),
    lifecycleConfig: LifecycleConfigurationSchema.optional(),
    sessionStoragePath: SessionStorageSchema.shape.mountPath.optional(),
    efsAccessPoints: z.array(EfsAccessPointConfigSchema).max(2).optional(),
    s3AccessPoints: z.array(S3FilesAccessPointConfigSchema).max(2).optional(),
    environmentVariables: z
      // Key bound (Smithy EnvironmentVariableKey: length 1–100, no character pattern) — an empty or
      // >100-char key passes a bare z.string() here but fails at CFN CREATE.
      .record(z.string().min(1).max(MAX_ENV_VAR_KEY_LENGTH), z.string().max(MAX_ENV_VAR_VALUE_LENGTH))
      .refine(rec => Object.keys(rec).length <= MAX_ENV_VARS, {
        message: `A maximum of ${MAX_ENV_VARS} environment variables is allowed`,
      })
      .optional(),
    /** Authorizer type for inbound requests. Defaults to AWS_IAM. */
    authorizerType: RuntimeAuthorizerTypeSchema.optional(),
    /** Authorizer configuration. Required when authorizerType is CUSTOM_JWT. */
    authorizerConfiguration: AuthorizerConfigSchema.optional(),
    /** Connections to external AgentCore resources (memory/gateway/runtime). The construct
     *  generates IAM + discovery env vars onto this harness's execution role. */
    connections: z.array(ConnectionSchema).optional(),
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
    if ((data.efsAccessPoints?.length || data.s3AccessPoints?.length) && data.networkMode !== 'VPC') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'efsAccessPoints and s3AccessPoints require networkMode: VPC',
        path: ['efsAccessPoints'],
      });
    }
    const mountPaths: string[] = [];
    if (data.sessionStoragePath) mountPaths.push(data.sessionStoragePath.replace(/\/$/, ''));
    for (const ap of data.efsAccessPoints ?? []) mountPaths.push(ap.mountPath.replace(/\/$/, ''));
    for (const ap of data.s3AccessPoints ?? []) mountPaths.push(ap.mountPath.replace(/\/$/, ''));
    if (new Set(mountPaths).size !== mountPaths.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Filesystem mount paths must be unique',
        path: ['efsAccessPoints'],
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
