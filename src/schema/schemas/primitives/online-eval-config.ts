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

/** Allowed operator values for an online evaluation filter (matches AgentCore service API). */
export const OnlineEvalFilterOperatorSchema = z.enum([
  'Equals',
  'NotEquals',
  'GreaterThan',
  'LessThan',
  'GreaterThanOrEqual',
  'LessThanOrEqual',
  'Contains',
  'NotContains',
]);
export type OnlineEvalFilterOperator = z.infer<typeof OnlineEvalFilterOperatorSchema>;

/** Filter value — exactly one of stringValue / doubleValue / booleanValue should be set. */
export const OnlineEvalFilterValueSchema = z
  .object({
    stringValue: z.string().optional(),
    doubleValue: z.number().optional(),
    booleanValue: z.boolean().optional(),
  })
  .refine(
    v => [v.stringValue, v.doubleValue, v.booleanValue].filter(x => x !== undefined).length === 1,
    'Exactly one of stringValue, doubleValue, or booleanValue must be set'
  );
export type OnlineEvalFilterValue = z.infer<typeof OnlineEvalFilterValueSchema>;

export const OnlineEvalFilterSchema = z.object({
  key: z.string().min(1, 'Filter key is required'),
  operator: OnlineEvalFilterOperatorSchema,
  value: OnlineEvalFilterValueSchema,
});
export type OnlineEvalFilter = z.infer<typeof OnlineEvalFilterSchema>;

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
  /** Optional filters applied to the evaluation rule */
  filters: z.array(OnlineEvalFilterSchema).optional(),
  /** Whether to enable execution on create (default: true) */
  enableOnCreate: z.boolean().optional(),
  tags: TagsSchema.optional(),
});

export type OnlineEvalConfig = z.infer<typeof OnlineEvalConfigSchema>;
