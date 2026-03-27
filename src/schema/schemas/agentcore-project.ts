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
import { EvaluationLevelSchema, EvaluatorConfigSchema, EvaluatorNameSchema } from './primitives/evaluator';
import {
  DEFAULT_EPISODIC_REFLECTION_NAMESPACES,
  DEFAULT_STRATEGY_NAMESPACES,
  MemoryStrategySchema,
  MemoryStrategyTypeSchema,
} from './primitives/memory';
import { OnlineEvalConfigSchema } from './primitives/online-eval-config';
import { PolicyEngineSchema } from './primitives/policy';
import { TagsSchema } from './primitives/tags';
import { uniqueBy } from './zod-util';
import { z } from 'zod';

// Re-export for convenience
export {
  DEFAULT_EPISODIC_REFLECTION_NAMESPACES,
  DEFAULT_STRATEGY_NAMESPACES,
  MemoryStrategySchema,
  MemoryStrategyTypeSchema,
};
export { EvaluationLevelSchema };
export type { MemoryStrategy, MemoryStrategyType } from './primitives/memory';
export type { OnlineEvalConfig } from './primitives/online-eval-config';
export { OnlineEvalConfigSchema, OnlineEvalConfigNameSchema } from './primitives/online-eval-config';
export type { EvaluationLevel, EvaluatorConfig, LlmAsAJudgeConfig, RatingScale } from './primitives/evaluator';
export { BedrockModelIdSchema, isValidBedrockModelId, EvaluatorNameSchema } from './primitives/evaluator';
export { PolicyEngineSchema };
export type { Policy, PolicyEngine, ValidationMode } from './primitives/policy';
export { PolicyEngineNameSchema, PolicyNameSchema, PolicySchema, ValidationModeSchema } from './primitives/policy';
export { TagsSchema };
export type { Tags } from './primitives/tags';

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
    message: 'This name conflicts with a Python package dependency. Please choose a different name.',
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

export const MemorySchema = z.object({
  name: MemoryNameSchema,
  eventExpiryDuration: z.number().int().min(7).max(365),
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
  tags: TagsSchema.optional(),
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

export const CredentialTypeSchema = z.enum(['ApiKeyCredentialProvider', 'OAuthCredentialProvider']);
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

export const CredentialSchema = z.discriminatedUnion('authorizerType', [ApiKeyCredentialSchema, OAuthCredentialSchema]);

export type Credential = z.infer<typeof CredentialSchema>;

// ============================================================================
// Evaluator Schema
// ============================================================================

export const EvaluatorTypeSchema = z.literal('CustomEvaluator');
export type EvaluatorType = z.infer<typeof EvaluatorTypeSchema>;

export const EvaluatorSchema = z.object({
  name: EvaluatorNameSchema,
  level: EvaluationLevelSchema,
  description: z.string().optional(),
  config: EvaluatorConfigSchema,
  tags: TagsSchema.optional(),
});

export type Evaluator = z.infer<typeof EvaluatorSchema>;

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
  })
  .strict()
  .superRefine((spec, ctx) => {
    const agentNames = new Set(spec.runtimes.map(a => a.name));
    const evaluatorNames = new Set(spec.evaluators.map(e => e.name));

    for (const config of spec.onlineEvalConfigs) {
      // Validate agent reference
      if (!agentNames.has(config.agent)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Online eval config "${config.name}" references unknown agent "${config.agent}"`,
        });
      }

      // Validate evaluator references
      for (const evalName of config.evaluators) {
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
  });

export type AgentCoreProjectSpec = z.infer<typeof AgentCoreProjectSpecSchema>;
