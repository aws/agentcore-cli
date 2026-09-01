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

export const EvaluatorModelProviderSchema = z.enum(['Bedrock', 'OpenResponses']);
export type EvaluatorModelProvider = z.infer<typeof EvaluatorModelProviderSchema>;

// eslint-disable-next-line security/detect-unsafe-regex -- anchored pattern, no backtracking risk
const BEDROCK_MODEL_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-zA-Z0-9._-]+(:[0-9]+)?$/;
const BEDROCK_ARN_PATTERN = /^arn:aws[a-z-]*:bedrock:[a-z0-9-]+:\d{12}:(inference-profile|foundation-model)\/.+$/;

export function isValidBedrockModelId(value: string): boolean {
  return BEDROCK_MODEL_ID_PATTERN.test(value) || BEDROCK_ARN_PATTERN.test(value);
}

export const EvaluatorModelIdSchema = z
  .string()
  .trim()
  .min(1, 'Model ID is required')
  .max(2048, 'Model ID must be 2048 characters or fewer')
  .regex(/^[\x21-\x7e]+$/, 'Model ID must contain only printable ASCII characters without spaces');

// Retained for compatibility with existing imports.
export const BedrockModelIdSchema = EvaluatorModelIdSchema;

export const LlmAsAJudgeConfigSchema = z.object({
  modelProvider: EvaluatorModelProviderSchema.optional(),
  model: EvaluatorModelIdSchema,
  instructions: z.string().min(1, 'Evaluation instructions are required'),
  ratingScale: RatingScaleSchema,
});

export type LlmAsAJudgeConfig = z.infer<typeof LlmAsAJudgeConfigSchema>;

// ============================================================================
// Derived Evaluator Config
// ============================================================================

// A derived evaluator reuses a managed base evaluator's logic (prompt + scoring)
// and runs it on the customer's own model. The base is a managed metric — a
// third-party library metric (ThirdParty.<Provider>.<Metric>) or a built-in
// (Builtin.<Metric>). The base owns the prompt and scoring; the customer supplies
// only the model. The evaluator's `level` must match the base's level (resolved at
// add time via GetEvaluator), so it lives on the top-level Evaluator, not here.
// Builtin.<Metric> or ThirdParty.<Provider>.<Metric>. Each segment must be
// non-empty alphanumeric — rejects malformed ids like "ThirdParty.DeepEval",
// "ThirdParty..ToolUse", or "ThirdParty.DeepEval.".
export const BASE_EVALUATOR_ID_PATTERN = /^(Builtin\.[A-Za-z0-9]+|ThirdParty\.[A-Za-z0-9]+\.[A-Za-z0-9]+)$/;

export const DerivedEvaluatorConfigSchema = z.object({
  baseEvaluatorId: z
    .string()
    .min(1)
    .regex(
      BASE_EVALUATOR_ID_PATTERN,
      'Must be a managed base id: "ThirdParty.<Provider>.<Metric>" or "Builtin.<Metric>"'
    ),
  model: BedrockModelIdSchema,
});

export type DerivedEvaluatorConfig = z.infer<typeof DerivedEvaluatorConfigSchema>;

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
    derived: DerivedEvaluatorConfigSchema.optional(),
  })
  .superRefine((config, ctx) => {
    const arms = [config.llmAsAJudge, config.codeBased, config.derived].filter(Boolean).length;
    if (arms !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Config must have exactly one of llmAsAJudge, codeBased, or derived',
      });
    }
  });

export type EvaluatorConfig = z.infer<typeof EvaluatorConfigSchema>;

// ============================================================================
// KMS Key ARN Validation
// ============================================================================

/**
 * Pattern for KMS key ARNs accepted by the AgentCore Evaluation service.
 * Matches key ARNs across all AWS partitions with a 36-char UUID key ID.
 * Alias ARNs are not supported by the service for evaluator encryption.
 */
export const KMS_KEY_ARN_PATTERN = /^arn:[^:]+:kms:[a-zA-Z0-9-]*:[0-9]{12}:key\/[a-zA-Z0-9-]{36}$/;

export const KmsKeyArnSchema = z
  .string()
  .regex(
    KMS_KEY_ARN_PATTERN,
    'Must be a valid KMS key ARN (e.g. arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012)'
  );

export function isValidKmsKeyArn(value: string): boolean {
  return KMS_KEY_ARN_PATTERN.test(value);
}
