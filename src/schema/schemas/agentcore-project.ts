/**
 * AgentCore Project Schema - Resource-centric model
 *
 * Flat resource model where agents, memories, and credentials are top-level.
 * All resources within a project implicitly have access to each other.
 *
 * @module agentcore-project
 */
import { isReservedProjectName } from '../constants';
import { AgentEnvSpecSchema } from './agent-env';
import { AgentCoreGatewaySchema, AgentCoreGatewayTargetSchema, AgentCoreMcpRuntimeToolSchema } from './mcp';
import { ABTestSchema } from './primitives/ab-test';
import { CapacityProviderSchema } from './primitives/capacity-provider';
import { ConfigBundleSchema } from './primitives/config-bundle';
import { DatasetSchema } from './primitives/dataset';
import {
  EvaluationLevelSchema,
  EvaluatorConfigSchema,
  EvaluatorNameSchema,
  KmsKeyArnSchema,
} from './primitives/evaluator';
import { HarnessNameSchema } from './primitives/harness';
import { KnowledgeBaseSchema } from './primitives/knowledge-base';
import {
  DEFAULT_EPISODIC_REFLECTION_NAMESPACES,
  DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES,
  DEFAULT_STRATEGY_NAMESPACES,
  DEFAULT_STRATEGY_NAMESPACE_TEMPLATES,
  MemoryStrategySchema,
  MemoryStrategyTypeSchema,
} from './primitives/memory';
import { OnlineEvalConfigSchema } from './primitives/online-eval-config';
import {
  DEFAULT_AUTO_PAYMENT,
  DEFAULT_SPEND_LIMIT,
  PaymentAuthorizerTypeSchema,
  PaymentConnectorNameSchema,
  PaymentConnectorSchema,
  PaymentManagerNameSchema,
  PaymentManagerSchema,
  PaymentProviderSchema,
  PaymentProvisionModeSchema,
} from './primitives/payment';
import { PolicyEngineSchema } from './primitives/policy';
import { TagsSchema } from './primitives/tags';
import { uniqueBy } from './zod-util';
import { z } from 'zod';

// Re-export for convenience
export {
  DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES,
  DEFAULT_EPISODIC_REFLECTION_NAMESPACES,
  DEFAULT_STRATEGY_NAMESPACE_TEMPLATES,
  DEFAULT_STRATEGY_NAMESPACES,
  MemoryStrategySchema,
  MemoryStrategyTypeSchema,
};
export { EvaluationLevelSchema };
export type { MemoryStrategy, MemoryStrategyType } from './primitives/memory';
export type { OnlineEvalConfig } from './primitives/online-eval-config';
export { OnlineEvalConfigSchema, OnlineEvalConfigNameSchema } from './primitives/online-eval-config';
export type {
  CodeBasedConfig,
  EvaluationLevel,
  EvaluatorConfig,
  ExternalCodeBasedConfig,
  LlmAsAJudgeConfig,
  ManagedCodeBasedConfig,
  RatingScale,
} from './primitives/evaluator';
export {
  BASE_EVALUATOR_ID_PATTERN,
  BedrockModelIdSchema,
  isValidBedrockModelId,
  EvaluatorNameSchema,
  KMS_KEY_ARN_PATTERN,
  isValidKmsKeyArn,
} from './primitives/evaluator';
export type { DerivedEvaluatorConfig } from './primitives/evaluator';
export { ConfigBundleSchema };
export type { ComponentConfiguration, ComponentConfigurationMap, ConfigBundle } from './primitives/config-bundle';
export { ConfigBundleNameSchema, ComponentConfigurationMapSchema } from './primitives/config-bundle';
export { PolicyEngineSchema };
export type { AuthorizationPhase, EnforcementMode, Policy, PolicyEngine, ValidationMode } from './primitives/policy';
export {
  AuthorizationPhaseSchema,
  EnforcementModeSchema,
  PolicyEngineNameSchema,
  PolicyNameSchema,
  PolicySchema,
  ValidationModeSchema,
} from './primitives/policy';
export { TagsSchema };
export type { Tags } from './primitives/tags';
export { DatasetSchema };
export { DatasetNameSchema, DatasetSchemaTypeSchema } from './primitives/dataset';
export type { Dataset, DatasetSchemaType } from './primitives/dataset';
export { CapacityProviderSchema };
export {
  CapacityProviderArnSchema,
  CapacityProviderConfigurationSchema,
  CapacityProviderNameSchema,
  CapacityProviderVolumeNameSchema,
  CAPACITY_PROVIDER_ARN_PATTERN,
  CAPACITY_PROVIDER_OPERATOR_ROLE_ARN_PATTERN,
  isCapacityProviderArn,
  isValidOperatorRoleArn,
  OperatingSystemSchema,
  OperatorRoleArnSchema,
} from './primitives/capacity-provider';
export type { CapacityProvider, CapacityProviderConfiguration, OperatingSystem } from './primitives/capacity-provider';
export type { ABTestMode, TargetRef, GatewayFilter, PerVariantOnlineEvaluationConfig } from './primitives/ab-test';
export { ABTestModeSchema, TargetRefSchema, GatewayFilterSchema } from './primitives/ab-test';
export type {
  BedrockApiFormat,
  HarnessApiFormat,
  HarnessGatewayOutboundAuth,
  HarnessMemoryRef,
  HarnessModel,
  HarnessModelProvider,
  HarnessSpec,
  ManagedMemoryStrategy,
  OpenAiApiFormat,
} from './primitives/harness';
export {
  BedrockApiFormatSchema,
  HarnessApiFormatSchema,
  OpenAiApiFormatSchema,
  GatewayOAuthGrantTypeSchema,
  HarnessGatewayOutboundAuthSchema,
  HarnessModelProviderSchema,
  HarnessNameSchema,
  HarnessSpecSchema,
  HarnessToolTypeSchema,
  ManagedMemoryStrategySchema,
  validateApiFormat,
} from './primitives/harness';
export type {
  KnowledgeBase,
  DataSource,
  S3DataSource,
  ConnectorDataSourceType,
  ConnectorFileDataSource,
} from './primitives/knowledge-base';
export {
  KnowledgeBaseNameSchema,
  KnowledgeBaseSchema,
  S3DataSourceSchema,
  DataSourceSchema,
  ConnectorDataSourceTypeSchema,
  ConnectorFileDataSourceSchema,
} from './primitives/knowledge-base';
export {
  DEFAULT_AUTO_PAYMENT,
  DEFAULT_SPEND_LIMIT,
  PaymentManagerSchema,
  PaymentManagerNameSchema,
  PaymentConnectorSchema,
  PaymentConnectorNameSchema,
  PaymentProviderSchema,
  PaymentProvisionModeSchema,
  PaymentAuthorizerTypeSchema,
};
export type {
  PaymentManager,
  PaymentConnector,
  PaymentProvider,
  PaymentProvisionMode,
  PaymentAuthorizerType,
} from './primitives/payment';

// ============================================================================
// ManagedBy Schema
// ============================================================================

export const ManagedBySchema = z.enum(['CDK']).default('CDK');
export type ManagedBy = z.infer<typeof ManagedBySchema>;

// Re-export MCP types (now part of unified schema)
export type { AgentCoreGateway, AgentCoreGatewayTarget, AgentCoreMcpRuntimeTool } from './mcp';
export { AgentCoreGatewaySchema, AgentCoreGatewayTargetSchema, AgentCoreMcpRuntimeToolSchema } from './mcp';

// ============================================================================
// Project Name Schema
// ============================================================================

// Project name is a CLI-only concept (combined with agent name to form the runtime name).
// Max 23 so that projectName + "_" + agentName fits within the 48-char runtime name limit.
export const ProjectNameSchema = z
  .string()
  .min(1, 'Project name is required')
  .max(23, 'Project name must be 23 characters or less')
  .regex(
    /^[A-Za-z][A-Za-z0-9]{0,22}$/,
    'Project name must start with a letter and contain only alphanumeric characters'
  )
  .refine(name => !isReservedProjectName(name), {
    message: 'This name conflicts with a reserved package dependency. Please choose a different name.',
  });

// ============================================================================
// Memory Schema
// ============================================================================

export const MemoryTypeSchema = z.literal('AgentCoreMemory');
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

// Memory names follow the same constraints as agent runtime names.
// https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateMemory.html
export const MemoryNameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

export const StreamContentLevelSchema = z.enum(['FULL_CONTENT', 'METADATA_ONLY']);
export type StreamContentLevel = z.infer<typeof StreamContentLevelSchema>;

// TODO: kinesis is currently the only supported delivery type. When additional types
// (e.g. S3, EventBridge) are added, this should become a discriminated union.
// Non-kinesis resources will produce a Zod error about the missing kinesis field.
export const StreamDeliveryResourcesSchema = z.object({
  resources: z
    .array(
      z.object({
        kinesis: z.object({
          dataStreamArn: z.string().min(1),
          contentConfigurations: z
            .array(
              z.object({
                type: z.literal('MEMORY_RECORDS'),
                level: StreamContentLevelSchema,
              })
            )
            .min(1),
        }),
      })
    )
    .min(1),
});

export type StreamDeliveryResources = z.infer<typeof StreamDeliveryResourcesSchema>;

export const IndexedKeyTypeSchema = z.enum(['STRING', 'STRINGLIST', 'NUMBER']);
export type IndexedKeyType = z.infer<typeof IndexedKeyTypeSchema>;

/**
 * Indexed metadata key declaration on a Memory.
 * Indexed keys enable filtering memory records on retrieval by attached metadata.
 *
 * Key pattern matches the AgentCore Control API: alphanumeric characters, whitespace,
 * and the symbols `. _ : / = + @ -` (max 128 chars).
 *
 * Note: indexed keys are append-only on the AWS service side — once added to a Memory,
 * a key cannot be removed. Reducing the array on update will fail at deploy time.
 */
export const INDEXED_KEY_NAME_PATTERN = /^[a-zA-Z0-9\s._:/=+@-]+$/;
export const INDEXED_KEY_NAME_PATTERN_MESSAGE =
  'Must contain only alphanumeric characters, whitespace, or the symbols . _ : / = + @ -';
export const MAX_INDEXED_KEY_NAME_LENGTH = 128;
export const MAX_INDEXED_KEYS = 10;

export const IndexedKeySchema = z.object({
  key: z
    .string()
    .min(1)
    .max(MAX_INDEXED_KEY_NAME_LENGTH)
    .regex(INDEXED_KEY_NAME_PATTERN, INDEXED_KEY_NAME_PATTERN_MESSAGE)
    .refine(s => s.trim().length > 0, 'Key cannot be only whitespace'),
  type: IndexedKeyTypeSchema,
});
export type IndexedKey = z.infer<typeof IndexedKeySchema>;

export const MemorySchema = z
  .object({
    name: MemoryNameSchema,
    eventExpiryDuration: z.number().int().min(3).max(365),
    // Strategies array can be empty for short-term memory (just base memory with expiration)
    // Long-term memory includes strategies like SEMANTIC, SUMMARIZATION, USER_PREFERENCE
    strategies: z
      .array(MemoryStrategySchema)
      .default([])
      .superRefine(
        uniqueBy(
          strategy => strategy.type,
          type => `Duplicate memory strategy type: ${type}`
        )
      ),
    indexedKeys: z
      .array(IndexedKeySchema)
      .max(MAX_INDEXED_KEYS)
      .superRefine(
        uniqueBy(
          entry => entry.key,
          key => `Duplicate indexed key: ${key}`
        )
      )
      .optional(),
    tags: TagsSchema.optional(),
    encryptionKeyArn: z.string().optional(),
    executionRoleArn: z.string().optional(),
    streamDeliveryResources: StreamDeliveryResourcesSchema.optional(),
  })
  .superRefine((memory, ctx) => {
    // Indexed keys filter long-term memory records on retrieval; they have no
    // meaning on a short-term-only memory (no strategies => no LTM records).
    if (memory.indexedKeys && memory.indexedKeys.length > 0 && memory.strategies.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['indexedKeys'],
        message: 'indexedKeys requires at least one memory strategy (long-term memory)',
      });
    }
  });

export type Memory = z.infer<typeof MemorySchema>;

// ============================================================================
// Credential Schema
// ============================================================================

// https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateApiKeyCredentialProvider.html
export const CredentialNameSchema = z
  .string()
  .min(1, 'Credential name is required')
  .max(128, 'Credential name must be 128 characters or less')
  .regex(/^[a-zA-Z0-9\-_]+$/, 'Must contain only alphanumeric characters, hyphens, and underscores (1-128 chars)');

export const CredentialTypeSchema = z.enum([
  'ApiKeyCredentialProvider',
  'OAuthCredentialProvider',
  'PaymentCredentialProvider',
]);
export type CredentialType = z.infer<typeof CredentialTypeSchema>;

export const ApiKeyCredentialSchema = z.object({
  authorizerType: z.literal('ApiKeyCredentialProvider'),
  name: CredentialNameSchema,
});

export type ApiKeyCredential = z.infer<typeof ApiKeyCredentialSchema>;

export const OAuthCredentialSchema = z.object({
  authorizerType: z.literal('OAuthCredentialProvider'),
  name: CredentialNameSchema,
  /** OIDC discovery URL for the OAuth provider (optional for imported providers that already exist in Identity service) */
  discoveryUrl: z.string().url().optional(),
  /** Scopes this credential provider supports */
  scopes: z.array(z.string()).optional(),
  /** Credential provider vendor type */
  vendor: z.string().default('CustomOauth2'),
  /** Whether this credential was auto-created by the CLI (e.g., for CUSTOM_JWT inbound auth) */
  managed: z.boolean().optional(),
  /** Whether this credential is used for inbound or outbound auth */
  usage: z.enum(['inbound', 'outbound']).optional(),
});

export type OAuthCredential = z.infer<typeof OAuthCredentialSchema>;

export const PaymentCredentialSchema = z.object({
  authorizerType: z.literal('PaymentCredentialProvider'),
  name: CredentialNameSchema,
  provider: PaymentProviderSchema,
});

export type PaymentCredential = z.infer<typeof PaymentCredentialSchema>;

export const CredentialSchema = z.discriminatedUnion('authorizerType', [
  ApiKeyCredentialSchema,
  OAuthCredentialSchema,
  PaymentCredentialSchema,
]);

export type Credential = z.infer<typeof CredentialSchema>;

// ============================================================================
// Evaluator Schema
// ============================================================================

export const EvaluatorTypeSchema = z.literal('CustomEvaluator');
export type EvaluatorType = z.infer<typeof EvaluatorTypeSchema>;

export const EvaluatorSchema = z.object({
  name: EvaluatorNameSchema,
  // Required for every evaluator. For a derived evaluator it must match the base
  // metric's level; the CLI resolves it via GetEvaluator at add time.
  level: EvaluationLevelSchema,
  description: z.string().optional(),
  config: EvaluatorConfigSchema,
  kmsKeyArn: KmsKeyArnSchema.optional(),
  tags: TagsSchema.optional(),
});

export type Evaluator = z.infer<typeof EvaluatorSchema>;

// ============================================================================
// Harness Registry Schema
// ============================================================================

export const HarnessRegistryEntrySchema = z.object({
  name: HarnessNameSchema,
  path: z.string().min(1, 'Path to harness config directory is required'),
});

export type HarnessRegistryEntry = z.infer<typeof HarnessRegistryEntrySchema>;

// ============================================================================
// Project Schema (Top Level)
// ============================================================================

const BUILTIN_EVALUATOR_PREFIX = 'Builtin.';
const ARN_PREFIX = 'arn:';

export const AgentCoreProjectSpecSchema = z
  .object({
    $schema: z.string().optional(),
    name: ProjectNameSchema,
    version: z.number().int().min(1),
    managedBy: ManagedBySchema,
    tags: TagsSchema.optional(),

    runtimes: z
      .array(AgentEnvSpecSchema)
      .default([])
      .superRefine(
        uniqueBy(
          agent => agent.name,
          name => `Duplicate agent name: ${name}`
        )
      ),

    memories: z
      .array(MemorySchema)
      .default([])
      .superRefine(
        uniqueBy(
          memory => memory.name,
          name => `Duplicate memory name: ${name}`
        )
      ),

    knowledgeBases: z
      .array(KnowledgeBaseSchema)
      .default([])
      .superRefine(
        uniqueBy(
          kb => kb.name,
          name => `Duplicate knowledge base name: ${name}`
        )
      ),

    credentials: z
      .array(CredentialSchema)
      .default([])
      .superRefine(
        uniqueBy(
          credential => credential.name,
          name => `Duplicate credential name: ${name}`
        )
      ),

    evaluators: z
      .array(EvaluatorSchema)
      .default([])
      .superRefine(
        uniqueBy(
          evaluator => evaluator.name,
          name => `Duplicate evaluator name: ${name}`
        )
      ),

    onlineEvalConfigs: z
      .array(OnlineEvalConfigSchema)
      .default([])
      .superRefine(
        uniqueBy(
          config => config.name,
          name => `Duplicate online eval config name: ${name}`
        )
      ),

    // MCP / Gateway resources (previously in mcp.json)
    agentCoreGateways: z
      .array(AgentCoreGatewaySchema)
      .default([])
      .superRefine(
        uniqueBy(
          gateway => gateway.name,
          name => `Duplicate gateway name: ${name}`
        )
      ),

    mcpRuntimeTools: z
      .array(AgentCoreMcpRuntimeToolSchema)
      .optional()
      .superRefine((tools, ctx) => {
        if (!tools) return;
        uniqueBy(
          (tool: { name: string }) => tool.name,
          (name: string) => `Duplicate MCP runtime tool name: ${name}`
        )(tools, ctx);
      }),

    unassignedTargets: z
      .array(AgentCoreGatewayTargetSchema)
      .optional()
      .superRefine((targets, ctx) => {
        if (!targets) return;
        uniqueBy(
          (target: { name: string }) => target.name,
          (name: string) => `Duplicate unassigned target name: ${name}`
        )(targets, ctx);
      }),

    policyEngines: z
      .array(PolicyEngineSchema)
      .default([])
      .superRefine(
        uniqueBy(
          engine => engine.name,
          name => `Duplicate policy engine name: ${name}`
        )
      ),

    configBundles: z
      .array(ConfigBundleSchema)
      .default([])
      .superRefine(
        uniqueBy(
          bundle => bundle.name,
          name => `Duplicate config bundle name: ${name}`
        )
      ),

    abTests: z
      .array(ABTestSchema)
      .default([])
      .superRefine(
        uniqueBy(
          test => test.name,
          name => `Duplicate AB test name: ${name}`
        )
      ),

    harnesses: z
      .array(HarnessRegistryEntrySchema)
      .default([])
      .superRefine(
        uniqueBy(
          harness => harness.name,
          name => `Duplicate harness name: ${name}`
        )
      ),

    datasets: z
      .array(DatasetSchema)
      .optional()
      .superRefine((val, ctx) => {
        if (!val) return;
        const seen = new Set<string>();
        for (const dataset of val) {
          if (seen.has(dataset.name)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate dataset name: ${dataset.name}` });
          }
          seen.add(dataset.name);
        }
      }),

    capacityProviders: z
      .array(CapacityProviderSchema)
      .optional()
      .superRefine((items, ctx) => {
        if (!items) return;
        uniqueBy(
          (cp: { name: string }) => cp.name,
          (name: string) => `Duplicate capacity provider name: ${name}`
        )(items, ctx);
      }),

    httpGateways: z
      .array(z.unknown())
      .max(
        0,
        '"httpGateways" is deprecated. Migrate to agentCoreGateways with protocolType: "None", or use "agentcore import gateway".'
      )
      .optional(),

    payments: z
      .array(PaymentManagerSchema)
      .optional()
      .superRefine((items, ctx) => {
        if (!items) return;
        uniqueBy(
          (manager: { name: string }) => manager.name,
          (name: string) => `Duplicate payment manager name: ${name}`
        )(items, ctx);
      }),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const agentNames = new Set(spec.runtimes.map(a => a.name));
    const evaluatorNames = new Set(spec.evaluators.map(e => e.name));

    for (const config of spec.onlineEvalConfigs) {
      // Validate agent reference (only when agent is specified — custom log groups don't need one)
      if (config.agent && !agentNames.has(config.agent)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Online eval config "${config.name}" references unknown agent "${config.agent}"`,
        });
      }

      // Validate evaluator references
      for (const evalName of config.evaluators ?? []) {
        // Skip built-in evaluators and ARN references (externally managed)
        if (evalName.startsWith(BUILTIN_EVALUATOR_PREFIX) || evalName.startsWith(ARN_PREFIX)) continue;
        if (!evaluatorNames.has(evalName)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Online eval config "${config.name}" references unknown evaluator "${evalName}"`,
          });
        }
      }
    }

    // Validate httpRuntime target runtime references
    for (const gw of spec.agentCoreGateways ?? []) {
      for (const target of gw.targets) {
        if (target.targetType === 'httpRuntime') {
          if (target.httpRuntime?.runtime) {
            const runtimeExists = spec.runtimes.some(r => r.name === target.httpRuntime!.runtime);
            if (!runtimeExists) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Gateway "${gw.name}" target "${target.name}" references unknown runtime "${target.httpRuntime.runtime}". Check spec.runtimes.`,
              });
            } else if (target.httpRuntime.runtimeEndpoint && target.httpRuntime.runtimeEndpoint !== 'DEFAULT') {
              const runtime = spec.runtimes.find(r => r.name === target.httpRuntime!.runtime);
              if (runtime && !runtime.endpoints?.[target.httpRuntime.runtimeEndpoint]) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `Gateway "${gw.name}" target "${target.name}" references endpoint "${target.httpRuntime.runtimeEndpoint}" which does not exist on runtime "${target.httpRuntime.runtime}".`,
                });
              }
            }
          }
        }
      }
    }

    // Validate runtime -> capacity-provider sibling references. A runtime may attach to a
    // capacity provider by name (an in-project sibling) or by ARN (external). A name must
    // resolve to a capacityProviders[] entry; ARNs are accepted as external and not checked here.
    const capacityProvidersByName = new Map((spec.capacityProviders ?? []).map(cp => [cp.name, cp]));
    for (const runtime of spec.runtimes) {
      const cpName = runtime.capacityProviderConfiguration?.capacityProviderName;
      if (cpName && !capacityProvidersByName.has(cpName)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Runtime "${runtime.name}" references unknown capacity provider "${cpName}". Check spec.capacityProviders.`,
        });
      }

      // A capacityProviderVolume mount must reference a volume defined on the attached CP. We can
      // only introspect an in-project sibling (by name); an external CP referenced by ARN is skipped.
      const cpVolumeMounts = (runtime.filesystemConfigurations ?? []).filter(fc => 'capacityProviderVolume' in fc);
      if (cpVolumeMounts.length > 0 && cpName) {
        const cp = capacityProvidersByName.get(cpName);
        if (cp) {
          const definedVolumeNames = new Set(
            (cp.computeConfiguration.ec2Configuration.volumes ?? []).map(v => v.ebsConfiguration.name)
          );
          for (const fc of cpVolumeMounts) {
            const volumeName = (fc as { capacityProviderVolume: { volumeName: string } }).capacityProviderVolume
              .volumeName;
            if (!definedVolumeNames.has(volumeName)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Runtime "${runtime.name}" mounts capacity provider volume "${volumeName}" which is not defined on capacity provider "${cpName}". Check its computeConfiguration.ec2Configuration.volumes.`,
              });
            }
          }
        }
      }
    }

    // Validate AB test gateway references
    for (const test of spec.abTests ?? []) {
      const gwField = test.gatewayRef;
      if (gwField && typeof gwField === 'string') {
        const match = /^\{\{gateway:(.+)\}\}$/.exec(gwField);
        if (match) {
          const gwName = match[1];
          const gwExists = (spec.agentCoreGateways ?? []).some(gw => gw.name === gwName);
          if (!gwExists) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `AB test "${test.name}" references gateway "${gwName}" which does not exist in agentCoreGateways`,
            });
          }

          // For target-based AB tests, validate target names exist in the gateway's targets array
          if (test.mode === 'target-based') {
            const gw = (spec.agentCoreGateways ?? []).find(g => g.name === gwName);
            if (gw) {
              const gwTargetNames = new Set((gw.targets ?? []).map(t => t.name));
              for (const variant of test.variants) {
                const targetName = variant.variantConfiguration.target?.targetName;
                if (targetName && !gwTargetNames.has(targetName)) {
                  ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `AB test "${test.name}" variant "${variant.name}" references target "${targetName}" which does not exist in gateway "${gwName}" targets`,
                  });
                }
              }
            }
          }
        }
      }
    }

    // Connector gateway target KB reference: a project KB name (entry in
    // knowledgeBases[]) or a literal 10-char KB ID (an external KB this
    // project does not own). Real KB IDs match ^[A-Z0-9]{10}$; KB names
    // start with a letter and may include dashes/underscores. The two
    // formats can never collide.
    const knowledgeBaseNames = new Set((spec.knowledgeBases ?? []).map(kb => kb.name));
    const REAL_KB_ID_PATTERN = /^[A-Z0-9]{10}$/;
    const validateKbReference = (target: { name: string }, value: string, fieldLabel: string): void => {
      const looksLikeRealId = REAL_KB_ID_PATTERN.test(value);
      if (looksLikeRealId) {
        if (knowledgeBaseNames.has(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Connector target "${target.name}" ${fieldLabel} "${value}" looks like a literal KB ID but also matches a knowledgeBases[] entry. Rename the knowledge base or reference it by its project name instead.`,
          });
        }
      } else {
        if (!knowledgeBaseNames.has(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Connector target "${target.name}" ${fieldLabel} "${value}" does not match any knowledgeBases[] entry. To wire an external KB that this project does not own, use its 10-character KB ID.`,
          });
        }
      }
    };

    for (const gateway of spec.agentCoreGateways ?? []) {
      for (const target of gateway.targets ?? []) {
        if (target.targetType !== 'connector') continue;
        if (target.connectorId !== 'bedrock-knowledge-bases') {
          continue;
        }
        for (const cfg of target.configurations ?? []) {
          const pv = cfg.parameterValues;
          if (cfg.name === 'Retrieve' && pv?.knowledgeBaseId && typeof pv.knowledgeBaseId === 'string') {
            validateKbReference(target, pv.knowledgeBaseId, 'configurations[].parameterValues.knowledgeBaseId');
          }
          if (cfg.name === 'AgenticRetrieveStream') {
            const rawRetrievers = pv?.retrievers;
            if (!Array.isArray(rawRetrievers)) continue;
            for (const r of rawRetrievers) {
              if (!r || typeof r !== 'object') continue;
              const kbId = (r as { configuration?: { knowledgeBase?: { knowledgeBaseId?: string } } }).configuration
                ?.knowledgeBase?.knowledgeBaseId;
              if (kbId)
                validateKbReference(target, kbId, 'configurations[].parameterValues.retrievers[].knowledgeBaseId');
            }
          }
        }
      }
    }

    // Validate payment connector credential references
    for (const payment of spec.payments ?? []) {
      const paymentIndex = (spec.payments ?? []).indexOf(payment);
      for (const connector of payment.connectors) {
        const connectorIndex = payment.connectors.indexOf(connector);
        if (connector.provisionMode === 'QUICK_CREATE') continue;
        const credential = spec.credentials.find(c => c.name === connector.credentialName);
        if (!credential) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Payment connector "${connector.name}" in manager "${payment.name}" references credential "${connector.credentialName}" which does not exist in credentials[]`,
            path: ['payments', paymentIndex, 'connectors', connectorIndex, 'credentialName'],
          });
        } else if (credential.authorizerType !== 'PaymentCredentialProvider') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Payment connector "${connector.name}" in manager "${payment.name}" references credential "${connector.credentialName}" which is a ${credential.authorizerType}, not a PaymentCredentialProvider`,
            path: ['payments', paymentIndex, 'connectors', connectorIndex, 'credentialName'],
          });
        }
      }
    }
  });

export type AgentCoreProjectSpec = z.infer<typeof AgentCoreProjectSpecSchema>;
