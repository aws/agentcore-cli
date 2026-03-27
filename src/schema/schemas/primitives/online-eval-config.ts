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

export const OnlineEvalConfigSchema = z.object({
  name: OnlineEvalConfigNameSchema,
  /** Agent name to monitor (must match a project agent) */
  agent: z.string().min(1, 'Agent name is required'),
  /** Evaluator names (custom), Builtin.* IDs, or evaluator ARNs */
  evaluators: z.array(z.string().min(1)).min(1, 'At least one evaluator is required'),
  /** Sampling rate as a percentage (0.01 to 100) */
  samplingRate: z.number().min(0.01).max(100),
  /** Optional description for the online eval config */
  description: z.string().max(200).optional(),
  /** Whether to enable execution on create (default: true) */
  enableOnCreate: z.boolean().optional(),
  tags: TagsSchema.optional(),
});

export type OnlineEvalConfig = z.infer<typeof OnlineEvalConfigSchema>;
