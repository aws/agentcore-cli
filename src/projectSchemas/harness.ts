import {
  MAX_CONTAINER_BUILD_SECURITY_GROUPS,
  NetworkModeSchema,
  isContainerBuild,
} from "./constants";
import {
  EfsAccessPointConfigSchema,
  LifecycleConfigurationSchema,
  NetworkConfigSchema,
  S3FilesAccessPointConfigSchema,
  SessionStorageSchema,
} from "./runtime";
import { AuthorizerConfigSchema, RuntimeAuthorizerTypeSchema } from "./auth";
import { ConnectionSchema } from "./connections";
import { uniqueBy } from "./zod-util";
import { TagsSchema } from "./tags";
import { z } from "zod";
export const CONTAINER_URI_PATTERN =
  /^(([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?|public\.ecr\.aws)\/((?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*)(?::([^:@]{1,300}))?(?:@(.+))?$/;
export const MAX_CONTAINER_URI_LENGTH = 1024;
export const MAX_ENV_VAR_VALUE_LENGTH = 5000;
export const MAX_ENV_VARS = 50;
export const MAX_ENV_VAR_KEY_LENGTH = 100;
export const HarnessNameSchema = z
  .string()
  .min(1, "Harness name is required")
  .max(40)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/,
    "Must begin with a letter and contain only alphanumeric characters and underscores (max 40 chars)",
  );
export const HarnessModelProviderSchema = z.enum(["bedrock", "open_ai", "gemini", "lite_llm"]);
export type HarnessModelProvider = z.infer<typeof HarnessModelProviderSchema>;
export const MAX_LITE_LLM_API_BASE_LENGTH = 16383;
export const BedrockApiFormatSchema = z.enum(["converse_stream", "responses", "chat_completions"]);
export type BedrockApiFormat = z.infer<typeof BedrockApiFormatSchema>;
export const OpenAiApiFormatSchema = z.enum(["responses", "chat_completions"]);
export type OpenAiApiFormat = z.infer<typeof OpenAiApiFormatSchema>;
export const HarnessApiFormatSchema = z.enum(["converse_stream", "responses", "chat_completions"]);
export type HarnessApiFormat = z.infer<typeof HarnessApiFormatSchema>;
export const HarnessModelSchema = z
  .object({
    provider: HarnessModelProviderSchema,
    modelId: z.string().min(1, "Model ID is required"),
    apiKeyArn: z.string().optional(),
    apiFormat: HarnessApiFormatSchema.optional(),
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().min(0).max(1).optional(),
    topK: z.number().int().min(0).max(500).optional(),
    maxTokens: z.number().int().min(1).optional(),
    apiBase: z.string().min(1).max(MAX_LITE_LLM_API_BASE_LENGTH).optional(),
    additionalParams: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((model, ctx) => {
    if (model.topK !== undefined && model.provider !== "gemini") {
      ctx.addIssue({
        code: "custom",
        message: 'topK is only supported for the "gemini" provider',
        path: ["topK"],
      });
    }
    if (model.apiFormat !== undefined) {
      if (model.provider !== "bedrock" && model.provider !== "open_ai") {
        ctx.addIssue({
          code: "custom",
          message: "--api-format is only supported for bedrock and open_ai providers",
          path: ["apiFormat"],
        });
      } else if (model.provider === "open_ai" && model.apiFormat === "converse_stream") {
        ctx.addIssue({
          code: "custom",
          message: `Invalid API format for open_ai: ${model.apiFormat}. Use ${OpenAiApiFormatSchema.options.join(", ")}`,
          path: ["apiFormat"],
        });
      }
    }
    if (
      model.apiKeyArn === undefined &&
      (model.provider === "open_ai" || model.provider === "gemini")
    ) {
      ctx.addIssue({
        code: "custom",
        message: `apiKeyArn is required for the "${model.provider}" provider`,
        path: ["apiKeyArn"],
      });
    }
    if (model.apiBase !== undefined && model.provider !== "lite_llm") {
      ctx.addIssue({
        code: "custom",
        message: 'apiBase is only supported for the "lite_llm" provider',
        path: ["apiBase"],
      });
    }
    if (model.additionalParams !== undefined && model.provider !== "lite_llm") {
      ctx.addIssue({
        code: "custom",
        message: 'additionalParams is only supported for the "lite_llm" provider',
        path: ["additionalParams"],
      });
    }
  });
export type HarnessModel = z.infer<typeof HarnessModelSchema>;
export function validateApiFormat(
  apiFormat: string,
  provider: string,
):
  | {
      valid: true;
    }
  | {
      valid: false;
      error: string;
    } {
  const allFormats = HarnessApiFormatSchema.options as readonly string[];
  if (!allFormats.includes(apiFormat)) {
    return {
      valid: false,
      error: `Invalid API format: ${apiFormat}. Use ${allFormats.join(", ")}`,
    };
  }
  if (provider !== "bedrock" && provider !== "open_ai") {
    return {
      valid: false,
      error: "--api-format is only supported for bedrock and open_ai providers",
    };
  }
  const result = HarnessModelSchema.safeParse({ provider, modelId: "placeholder", apiFormat });
  if (result.success) return { valid: true };
  const apiFormatIssue = result.error.issues.find((i) => i.path.includes("apiFormat"));
  if (apiFormatIssue) {
    return {
      valid: false,
      error: `Invalid API format for ${provider}: ${apiFormat}. Use ${(provider === "open_ai" ? OpenAiApiFormatSchema : BedrockApiFormatSchema).options.join(", ")}`,
    };
  }
  return { valid: true };
}
export const HarnessToolTypeSchema = z.enum([
  "remote_mcp",
  "agentcore_browser",
  "agentcore_gateway",
  "inline_function",
  "agentcore_code_interpreter",
]);
export type HarnessToolType = z.infer<typeof HarnessToolTypeSchema>;
export const HarnessToolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    "Tool name must contain only alphanumeric characters, hyphens, and underscores (1-64 chars)",
  );
export const RemoteMcpConfigSchema = z
  .object({
    remoteMcp: z.object({
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
    }),
  })
  .strict();
export const AgentCoreBrowserConfigSchema = z
  .object({
    agentCoreBrowser: z.object({
      browserArn: z.string().optional(),
    }),
  })
  .strict();
export const AgentCoreCodeInterpreterConfigSchema = z
  .object({
    agentCoreCodeInterpreter: z.object({
      codeInterpreterArn: z.string().optional(),
    }),
  })
  .strict();
export const GatewayOAuthGrantTypeSchema = z.enum(["CLIENT_CREDENTIALS", "USER_FEDERATION"]);
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
export const AgentCoreGatewayConfigSchema = z
  .object({
    agentCoreGateway: z
      .object({
        gatewayArn: z.string().min(1),
        outboundAuth: HarnessGatewayOutboundAuthSchema.optional(),
      })
      .passthrough()
      .superRefine((data, ctx) => {
        if ("credentialProviderName" in data) {
          ctx.addIssue({
            code: "custom",
            message:
              'credentialProviderName is no longer supported. Use outboundAuth instead. Example: outboundAuth: { awsIam: {} } or outboundAuth: { oauth: { providerArn: "...", scopes: [...] } }',
            path: ["credentialProviderName"],
          });
        }
      }),
  })
  .strict();
export const InlineFunctionConfigSchema = z
  .object({
    inlineFunction: z.object({
      description: z.string().min(1),
      inputSchema: z.record(z.string(), z.unknown()),
    }),
  })
  .strict();
export const HarnessToolConfigSchema = z.union([
  RemoteMcpConfigSchema,
  AgentCoreBrowserConfigSchema,
  AgentCoreCodeInterpreterConfigSchema,
  AgentCoreGatewayConfigSchema,
  InlineFunctionConfigSchema,
]);
const TOOL_TYPE_TO_CONFIG_KEY: Record<HarnessToolType, string> = {
  remote_mcp: "remoteMcp",
  agentcore_browser: "agentCoreBrowser",
  agentcore_gateway: "agentCoreGateway",
  inline_function: "inlineFunction",
  agentcore_code_interpreter: "agentCoreCodeInterpreter",
};
const TOOL_TYPES_REQUIRING_CONFIG = new Set<HarnessToolType>([
  "remote_mcp",
  "agentcore_gateway",
  "inline_function",
]);
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
          code: "custom",
          message: `Tool type "${tool.type}" requires a "${expectedKey}" config`,
          path: ["config"],
        });
      }
      return;
    }
    const configKeys = Object.keys(tool.config);
    if (configKeys.length !== 1 || configKeys[0] !== expectedKey) {
      ctx.addIssue({
        code: "custom",
        message: `Tool type "${tool.type}" requires "${expectedKey}" config, got "${configKeys[0]}"`,
        path: ["config"],
      });
    }
  });
export type HarnessTool = z.infer<typeof HarnessToolSchema>;
export const HarnessMemoryRetrievalConfigSchema = z
  .object({
    topK: z.number().int().min(1).optional(),
    relevanceScore: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine((v) => v.topK !== undefined || v.relevanceScore !== undefined, {
    message: "retrievalConfig must specify at least one of topK or relevanceScore",
  });
export type HarnessMemoryRetrievalConfig = z.infer<typeof HarnessMemoryRetrievalConfigSchema>;
export const ManagedMemoryStrategySchema = z.enum([
  "SEMANTIC",
  "SUMMARIZATION",
  "USER_PREFERENCE",
  "EPISODIC",
]);
const ManagedMemoryRefSchema = z
  .object({
    mode: z.literal("managed"),
    strategies: z.array(ManagedMemoryStrategySchema).min(1).max(4).optional(),
    eventExpiryDuration: z.number().int().min(3).max(365).optional(),
    encryptionKeyArn: z.string().min(1).optional(),
  })
  .strict();
const ExistingMemoryRefSchema = z
  .object({
    mode: z.literal("existing"),
    name: z.string().min(1).optional(),
    arn: z.string().min(1).optional(),
    actorId: z.string().optional(),
    messagesCount: z.number().int().min(1).optional(),
    retrievalConfig: HarnessMemoryRetrievalConfigSchema.optional(),
  })
  .strict()
  .refine((m) => m.arn != null || m.name != null, {
    message: "existing memory requires `arn` or `name`",
    path: ["name"],
  })
  .superRefine((ref, ctx) => {
    if (ref.arn && ref.retrievalConfig !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "retrievalConfig is not supported when memory is referenced by `arn` (per-namespace tuning is only resolvable for a by-name reference). Reference the memory by `name` only, or drop retrievalConfig.",
        path: ["retrievalConfig"],
      });
    }
  });
const DisabledMemoryRefSchema = z.object({ mode: z.literal("disabled") }).strict();
export const HarnessMemoryRefSchema = z.preprocess(
  (val) => {
    if (val == null || typeof val !== "object") return val;
    const obj = val as Record<string, unknown>;
    if ("mode" in obj) return obj;
    return { mode: "existing", ...obj };
  },
  z.discriminatedUnion("mode", [
    ManagedMemoryRefSchema,
    ExistingMemoryRefSchema,
    DisabledMemoryRefSchema,
  ]),
);
export type HarnessMemoryRef = z.infer<typeof HarnessMemoryRefSchema>;
export type ManagedMemoryStrategy = z.infer<typeof ManagedMemoryStrategySchema>;
export const HarnessTruncationStrategySchema = z.enum(["sliding_window", "summarization", "none"]);
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
    if (!data.config) return;
    const configKey = "slidingWindow" in data.config ? "slidingWindow" : "summarization";
    const expected: Record<typeof data.strategy, string | undefined> = {
      sliding_window: "slidingWindow",
      summarization: "summarization",
      none: undefined,
    };
    if (expected[data.strategy] === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `Truncation strategy "${data.strategy}" does not take a config`,
        path: ["config"],
      });
    } else if (expected[data.strategy] !== configKey) {
      ctx.addIssue({
        code: "custom",
        message: `Truncation strategy "${data.strategy}" requires a "${expected[data.strategy]}" config, got "${configKey}"`,
        path: ["config"],
      });
    }
  });
export type HarnessTruncationConfig = z.infer<typeof HarnessTruncationConfigSchema>;
export const HarnessSkillGitAuthSchema = z
  .object({
    credentialName: z.string().min(1).optional(),
    credentialArn: z.string().min(1).optional(),
    username: z.string().optional(),
  })
  .refine((data) => Boolean(data.credentialName) !== Boolean(data.credentialArn), {
    message: "Exactly one of credentialName or credentialArn must be provided",
    path: ["credentialName"],
  });
export type HarnessSkillGitAuth = z.infer<typeof HarnessSkillGitAuthSchema>;
export const HarnessSkillS3SourceSchema = z
  .object({
    s3Uri: z
      .string()
      .min(5)
      .regex(/^s3:\/\//, "Must be an S3 URI starting with s3://"),
  })
  .strict();
export type HarnessSkillS3Source = z.infer<typeof HarnessSkillS3SourceSchema>;
export const HarnessSkillGitSourceSchema = z
  .object({
    gitUrl: z
      .string()
      .min(8)
      .regex(/^https:\/\//, "Must be an HTTPS git URL"),
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
    .transform((path) => ({ path })),
  HarnessSkillS3SourceSchema,
  HarnessSkillGitSourceSchema,
  HarnessSkillPathSourceSchema,
  HarnessSkillAwsSkillsSourceSchema,
]);
export type HarnessSkillInput = z.input<typeof HarnessSkillSchema>;
export type HarnessSkill = z.output<typeof HarnessSkillSchema>;
export const AllowedToolSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(\*|@?[^/]+(\/[^/]+)?)$/, 'Must be "*" or a tool name pattern (max 64 chars)');
export function looksLikeLegacyPromptPath(value: string): boolean {
  const v = value.trim();
  if (!/^\S+$/.test(v)) return false;
  return /^\.\.?\//.test(v) || /\.(md|txt)$/i.test(v);
}
export const HarnessSpecSchema = z
  .object({
    name: HarnessNameSchema,
    model: HarnessModelSchema,
    systemPrompt: z
      .string()
      .refine((val) => val.trim().length > 0, {
        message: "systemPrompt must not be empty or whitespace-only",
      })
      .refine((val) => !looksLikeLegacyPromptPath(val), {
        message:
          "systemPrompt looks like a file path. It is now always literal text — put file-backed prompts in a `system-prompt.md` in the harness directory (auto-discovered), or inline the prompt text here.",
      })
      .optional(),
    tools: z
      .array(HarnessToolSchema)
      .default([])
      .superRefine(
        uniqueBy(
          (tool) => tool.name,
          (name) => `Duplicate tool name: ${name}`,
        ),
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
      .regex(
        CONTAINER_URI_PATTERN,
        "containerUri must be an ECR image URI (12-digit private ECR or public.ecr.aws)",
      )
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
      .record(
        z.string().min(1).max(MAX_ENV_VAR_KEY_LENGTH),
        z.string().max(MAX_ENV_VAR_VALUE_LENGTH),
      )
      .refine((rec) => Object.keys(rec).length <= MAX_ENV_VARS, {
        message: `A maximum of ${MAX_ENV_VARS} environment variables is allowed`,
      })
      .optional(),
    authorizerType: RuntimeAuthorizerTypeSchema.optional(),
    authorizerConfiguration: AuthorizerConfigSchema.optional(),
    connections: z.array(ConnectionSchema).optional(),
    tags: TagsSchema.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.containerUri !== undefined && data.dockerfile !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "containerUri and dockerfile are mutually exclusive",
        path: ["containerUri"],
      });
    }
    if (data.networkMode === "VPC" && !data.networkConfig) {
      ctx.addIssue({
        code: "custom",
        message: "networkConfig is required when networkMode is VPC",
        path: ["networkConfig"],
      });
    }
    if (data.networkMode !== "VPC" && data.networkConfig) {
      ctx.addIssue({
        code: "custom",
        message: "networkConfig is only allowed when networkMode is VPC",
        path: ["networkConfig"],
      });
    }
    if (data.networkMode === "VPC" && data.dockerfile && !data.networkConfig?.vpcId) {
      ctx.addIssue({
        code: "custom",
        message:
          "networkConfig.vpcId is required for Dockerfile builds in VPC mode (CodeBuild cannot infer the VPC from subnets)",
        path: ["networkConfig", "vpcId"],
      });
    }
    if (
      data.networkMode === "VPC" &&
      isContainerBuild(data) &&
      data.networkConfig &&
      data.networkConfig.securityGroups.length > MAX_CONTAINER_BUILD_SECURITY_GROUPS
    ) {
      ctx.addIssue({
        code: "custom",
        message: `Container builds in VPC mode allow at most ${MAX_CONTAINER_BUILD_SECURITY_GROUPS} security groups (CodeBuild limit)`,
        path: ["networkConfig", "securityGroups"],
      });
    }
    if (
      (data.efsAccessPoints?.length || data.s3AccessPoints?.length) &&
      data.networkMode !== "VPC"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "efsAccessPoints and s3AccessPoints require networkMode: VPC",
        path: ["efsAccessPoints"],
      });
    }
    const mountPaths: string[] = [];
    if (data.sessionStoragePath) mountPaths.push(data.sessionStoragePath.replace(/\/$/, ""));
    for (const ap of data.efsAccessPoints ?? []) mountPaths.push(ap.mountPath.replace(/\/$/, ""));
    for (const ap of data.s3AccessPoints ?? []) mountPaths.push(ap.mountPath.replace(/\/$/, ""));
    if (new Set(mountPaths).size !== mountPaths.length) {
      ctx.addIssue({
        code: "custom",
        message: "Filesystem mount paths must be unique",
        path: ["efsAccessPoints"],
      });
    }
    if (
      data.authorizerType === "CUSTOM_JWT" &&
      !data.authorizerConfiguration?.customJwtAuthorizer
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "authorizerConfiguration with customJwtAuthorizer is required when authorizerType is CUSTOM_JWT",
        path: ["authorizerConfiguration"],
      });
    }
    if (data.authorizerType !== "CUSTOM_JWT" && data.authorizerConfiguration) {
      ctx.addIssue({
        code: "custom",
        message: "authorizerConfiguration is only allowed when authorizerType is CUSTOM_JWT",
        path: ["authorizerConfiguration"],
      });
    }
  });
export type HarnessSpec = z.infer<typeof HarnessSpecSchema>;
export const HarnessRegistryEntrySchema = z.object({
  name: HarnessNameSchema,
  path: z.string().min(1, "Path to harness config directory is required"),
});
export type HarnessRegistryEntry = z.infer<typeof HarnessRegistryEntrySchema>;
