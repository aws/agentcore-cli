import { TagsSchema } from './tags';
import { z } from 'zod';

// ============================================================================
// Online Eval Config Types
// ============================================================================

export const OnlineEvalConfigNameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

// ────────────────────────────────────────────────────────────────────────────
// Filter rule types — mirror @aws/agentcore-cdk's OnlineEvaluationConfigSchema.
// Must stay in lock-step with that package; both schemas describe the same
// JSON in agentcore.json.
// ────────────────────────────────────────────────────────────────────────────

/** The 8 documented comparison operators for online evaluation config filters. */
export const FILTER_OPERATORS = [
  'Equals',
  'NotEquals',
  'GreaterThan',
  'LessThan',
  'GreaterThanOrEqual',
  'LessThanOrEqual',
  'Contains',
  'NotContains',
] as const;

export const FilterOperatorSchema = z.enum(FILTER_OPERATORS);
export type FilterOperator = z.infer<typeof FilterOperatorSchema>;

/**
 * Filter value — exactly one of stringValue, doubleValue, or booleanValue must
 * be set (matches the boto3 / CFN spec).
 */
export const FilterValueSchema = z
  .object({
    stringValue: z.string().optional(),
    doubleValue: z.number().optional(),
    booleanValue: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    const set = [val.stringValue !== undefined, val.doubleValue !== undefined, val.booleanValue !== undefined].filter(
      Boolean
    ).length;
    if (set !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Filter value must set exactly one of `stringValue`, `doubleValue`, or `booleanValue`',
      });
    }
  });
export type FilterValue = z.infer<typeof FilterValueSchema>;

export const FilterRuleSchema = z.object({
  /** Key or field name to filter on within the agent trace data. */
  key: z.string().min(1, 'Filter key is required'),
  /** Comparison operator. */
  operator: FilterOperatorSchema,
  /** The value used in filter comparisons (exactly one variant). */
  value: FilterValueSchema,
});
export type FilterRule = z.infer<typeof FilterRuleSchema>;

export const OnlineEvalConfigSchema = z.object({
  name: OnlineEvalConfigNameSchema,
  /** Agent name to monitor (must match a project agent) */
  agent: z.string().min(1, 'Agent name is required'),
  /** Optional runtime endpoint name to scope monitoring to a specific endpoint */
  endpoint: z.string().min(1).optional(),
  /** Evaluator names (custom), Builtin.* IDs, or evaluator ARNs */
  evaluators: z.array(z.string().min(1)).min(1, 'At least one evaluator is required'),
  /** Sampling rate as a percentage (0.01 to 100) */
  samplingRate: z.number().min(0.01).max(100),
  /** Optional description for the online eval config */
  description: z.string().max(200).optional(),
  /** Session idle timeout in minutes (1-1440). Default: 5 */
  sessionTimeoutMinutes: z.number().int().min(1).max(1440).optional(),
  /** Optional list of filter rules. Only traces matching all filters are evaluated. */
  filters: z.array(FilterRuleSchema).max(20).optional(),
  /** Whether to enable execution on create (default: true) */
  enableOnCreate: z.boolean().optional(),
  tags: TagsSchema.optional(),
});

export type OnlineEvalConfig = z.infer<typeof OnlineEvalConfigSchema>;
