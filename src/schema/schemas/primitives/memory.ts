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
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bedrockagentcore-memory-memorystrategy.html
 */
export const MemoryStrategyTypeSchema = z.enum(['SEMANTIC', 'SUMMARIZATION', 'USER_PREFERENCE']);
export type MemoryStrategyType = z.infer<typeof MemoryStrategyTypeSchema>;

/**
 * Default namespaces for each memory strategy type.
 * These match the patterns generated in CLI session.py templates.
 */
export const DEFAULT_STRATEGY_NAMESPACES: Partial<Record<MemoryStrategyType, string[]>> = {
  SEMANTIC: ['/users/{actorId}/facts'],
  USER_PREFERENCE: ['/users/{actorId}/preferences'],
  SUMMARIZATION: ['/summaries/{actorId}/{sessionId}'],
};

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
 */
export const MemoryStrategySchema = z.object({
  /** Strategy type */
  type: MemoryStrategyTypeSchema,
  /** Optional custom name for the strategy */
  name: MemoryStrategyNameSchema.optional(),
  /** Optional description */
  description: z.string().optional(),
  /** Optional namespaces for scoping memory access */
  namespaces: z.array(z.string()).optional(),
});

export type MemoryStrategy = z.infer<typeof MemoryStrategySchema>;
