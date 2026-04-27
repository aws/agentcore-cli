import { z } from 'zod';

// ============================================================================
// Evaluator Types
// ============================================================================

export const EvaluationLevelSchema = z.enum(['SESSION', 'TRACE', 'TOOL_CALL']);
export type EvaluationLevel = z.infer<typeof EvaluationLevelSchema>;

export const EvaluatorNameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

// ============================================================================
// Rating Scale
// ============================================================================

export const NumericalRatingSchema = z.object({
  value: z.number().int(),
  label: z.string().min(1),
  definition: z.string().min(1),
});

export type NumericalRating = z.infer<typeof NumericalRatingSchema>;

export const CategoricalRatingSchema = z.object({
  label: z.string().min(1),
  definition: z.string().min(1),
});

export type CategoricalRating = z.infer<typeof CategoricalRatingSchema>;

export const RatingScaleSchema = z
  .object({
    numerical: z.array(NumericalRatingSchema).optional(),
    categorical: z.array(CategoricalRatingSchema).optional(),
  })
  .refine(
    scale => {
      const hasNumerical = Boolean(scale.numerical);
      const hasCategorical = Boolean(scale.categorical);
      return hasNumerical !== hasCategorical;
    },
    { message: 'Rating scale must have either numerical or categorical, not both' }
  );

export type RatingScale = z.infer<typeof RatingScaleSchema>;

// ============================================================================
// LLM-as-a-Judge Config
// ============================================================================

// eslint-disable-next-line security/detect-unsafe-regex -- anchored pattern, no backtracking risk
const BEDROCK_MODEL_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-zA-Z0-9._-]+(:[0-9]+)?$/;
const BEDROCK_ARN_PATTERN = /^arn:aws[a-z-]*:bedrock:[a-z0-9-]+:\d{12}:(inference-profile|foundation-model)\/.+$/;

export function isValidBedrockModelId(value: string): boolean {
  return BEDROCK_MODEL_ID_PATTERN.test(value) || BEDROCK_ARN_PATTERN.test(value);
}

export const BedrockModelIdSchema = z.string().min(1, 'Model ID is required');

export const LlmAsAJudgeConfigSchema = z.object({
  model: BedrockModelIdSchema,
  instructions: z.string().min(1, 'Evaluation instructions are required'),
  ratingScale: RatingScaleSchema,
});

export type LlmAsAJudgeConfig = z.infer<typeof LlmAsAJudgeConfigSchema>;

// ============================================================================
// Code-Based Evaluator Config
// ============================================================================

export const ManagedCodeBasedConfigSchema = z.object({
  codeLocation: z.string().min(1),
  entrypoint: z.string().min(1).default('lambda_function.handler'),
  timeoutSeconds: z.number().int().min(1).max(300).default(60),
  additionalPolicies: z.array(z.string().min(1)).optional(),
});

export type ManagedCodeBasedConfig = z.infer<typeof ManagedCodeBasedConfigSchema>;

const LAMBDA_ARN_PATTERN = /^arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:.+$/;

export const ExternalCodeBasedConfigSchema = z.object({
  lambdaArn: z.string().min(1).regex(LAMBDA_ARN_PATTERN, 'Must be a valid Lambda function ARN'),
});

export type ExternalCodeBasedConfig = z.infer<typeof ExternalCodeBasedConfigSchema>;

export const CodeBasedConfigSchema = z
  .object({
    managed: ManagedCodeBasedConfigSchema.optional(),
    external: ExternalCodeBasedConfigSchema.optional(),
  })
  .refine(config => Boolean(config.managed) !== Boolean(config.external), {
    message: 'Code-based config must have either managed or external, not both',
  });

export type CodeBasedConfig = z.infer<typeof CodeBasedConfigSchema>;

// ============================================================================
// Evaluator Config
// ============================================================================

export const EvaluatorConfigSchema = z
  .object({
    llmAsAJudge: LlmAsAJudgeConfigSchema.optional(),
    codeBased: CodeBasedConfigSchema.optional(),
  })
  .refine(config => Boolean(config.llmAsAJudge) !== Boolean(config.codeBased), {
    message: 'Config must have either llmAsAJudge or codeBased, not both',
  });

export type EvaluatorConfig = z.infer<typeof EvaluatorConfigSchema>;
