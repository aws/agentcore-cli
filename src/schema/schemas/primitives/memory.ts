import { z } from 'zod';

// ============================================================================
// Memory Strategy Types
// ============================================================================

/**
 * Memory strategy types.
 * Maps to AWS MemoryStrategy types:
 * - SEMANTIC → SemanticMemoryStrategy
 * - SUMMARIZATION → SummaryMemoryStrategy (note: CloudFormation uses "Summary")
 * - USER_PREFERENCE → UserPreferenceMemoryStrategy
 * - EPISODIC → EpisodicMemoryStrategy
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bedrockagentcore-memory-memorystrategy.html
 */
export const MemoryStrategyTypeSchema = z.enum(['SEMANTIC', 'SUMMARIZATION', 'USER_PREFERENCE', 'EPISODIC']);
export type MemoryStrategyType = z.infer<typeof MemoryStrategyTypeSchema>;

/**
 * Default namespace templates for each memory strategy type.
 * These match the patterns generated in CLI session.py templates.
 */
export const DEFAULT_STRATEGY_NAMESPACE_TEMPLATES: Partial<Record<MemoryStrategyType, string[]>> = {
  SEMANTIC: ['/users/{actorId}/facts'],
  USER_PREFERENCE: ['/users/{actorId}/preferences'],
  SUMMARIZATION: ['/summaries/{actorId}/{sessionId}'],
  EPISODIC: ['/episodes/{actorId}/{sessionId}'],
};

/**
 * @deprecated Use {@link DEFAULT_STRATEGY_NAMESPACE_TEMPLATES} instead.
 * Retained as an alias for backward compatibility.
 */
export const DEFAULT_STRATEGY_NAMESPACES = DEFAULT_STRATEGY_NAMESPACE_TEMPLATES;

/**
 * Default reflection namespace templates for the EPISODIC strategy.
 * The service requires reflection templates to be the same as or a prefix of episode templates.
 */
export const DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES: string[] = ['/episodes/{actorId}'];

/**
 * @deprecated Use {@link DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES} instead.
 * Retained as an alias for backward compatibility.
 */
export const DEFAULT_EPISODIC_REFLECTION_NAMESPACES = DEFAULT_EPISODIC_REFLECTION_NAMESPACE_TEMPLATES;

/**
 * Memory strategy name validation.
 * Pattern: ^[a-zA-Z][a-zA-Z0-9_]{0,47}$
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-memory.html#cfn-bedrockagentcore-memory-name
 */
export const MemoryStrategyNameSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

/**
 * Memory strategy configuration.
 * Each memory can have multiple strategies with optional namespace scoping.
 *
 * Field naming:
 * - `namespaceTemplates` / `reflectionNamespaceTemplates` are the preferred field names.
 * - `namespaces` / `reflectionNamespaces` are deprecated aliases retained for backward
 *   compatibility. Specifying both the deprecated and preferred form for the same concept
 *   is rejected by validation.
 */
export const MemoryStrategySchema = z
  .object({
    /** Strategy type */
    type: MemoryStrategyTypeSchema,
    /** Optional custom name for the strategy */
    name: MemoryStrategyNameSchema.optional(),
    /** Optional description */
    description: z.string().optional(),
    /** Optional namespace templates for scoping memory access */
    namespaceTemplates: z.array(z.string()).optional(),
    /** @deprecated Use `namespaceTemplates` instead. */
    namespaces: z.array(z.string()).optional(),
    /** Reflection namespace templates for EPISODIC strategy. Required by the service for episodic strategies. */
    reflectionNamespaceTemplates: z.array(z.string()).optional(),
    /** @deprecated Use `reflectionNamespaceTemplates` instead. */
    reflectionNamespaces: z.array(z.string()).optional(),
  })
  .refine(strategy => !(strategy.namespaces !== undefined && strategy.namespaceTemplates !== undefined), {
    message:
      "'namespaces' and 'namespaceTemplates' are mutually exclusive. Prefer 'namespaceTemplates' ('namespaces' is deprecated).",
    path: ['namespaceTemplates'],
  })
  .refine(
    strategy => !(strategy.reflectionNamespaces !== undefined && strategy.reflectionNamespaceTemplates !== undefined),
    {
      message:
        "'reflectionNamespaces' and 'reflectionNamespaceTemplates' are mutually exclusive. Prefer 'reflectionNamespaceTemplates' ('reflectionNamespaces' is deprecated).",
      path: ['reflectionNamespaceTemplates'],
    }
  )
  .refine(
    strategy => {
      if (strategy.type !== 'EPISODIC') return true;
      const reflection = strategy.reflectionNamespaceTemplates ?? strategy.reflectionNamespaces;
      return reflection !== undefined && reflection.length > 0;
    },
    {
      message: 'EPISODIC strategy requires reflectionNamespaceTemplates',
      path: ['reflectionNamespaceTemplates'],
    }
  )
  .refine(
    strategy => {
      if (strategy.type !== 'EPISODIC') return true;
      const reflection = strategy.reflectionNamespaceTemplates ?? strategy.reflectionNamespaces;
      const templates = strategy.namespaceTemplates ?? strategy.namespaces;
      if (!reflection || !templates) return true;
      return reflection.every(ref => templates.some(ns => ns.startsWith(ref)));
    },
    {
      message: 'Each reflectionNamespaceTemplate must be a prefix of at least one namespaceTemplate',
      path: ['reflectionNamespaceTemplates'],
    }
  );

export type MemoryStrategy = z.infer<typeof MemoryStrategySchema>;
