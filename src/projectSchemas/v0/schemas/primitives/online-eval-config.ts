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

export const ClusteringConfigSchema = z.object({
  frequencies: z
    .array(z.enum(['DAILY', 'WEEKLY', 'MONTHLY']))
    .min(1)
    .max(3),
});

export type ClusteringConfig = z.infer<typeof ClusteringConfigSchema>;

export const OnlineEvalConfigSchema = z
  .object({
    name: OnlineEvalConfigNameSchema,
    /** Agent name to monitor (must match a project agent). Required when using managed AgentCore agents. */
    agent: z.string().min(1, 'Agent name is required').optional(),
    /** Optional runtime endpoint name to scope monitoring to a specific endpoint */
    endpoint: z.string().min(1).optional(),
    /** CloudWatch log group names for custom/3rd-party agents (1-5 entries) */
    logGroupNames: z.array(z.string().min(1)).min(1).max(5).optional(),
    /** Service names to filter traces for custom/3rd-party agents */
    serviceNames: z.array(z.string().min(1)).min(1).optional(),
    /** Evaluator names (custom), Builtin.* IDs, or evaluator ARNs */
    evaluators: z.array(z.string().min(1)).optional(),
    /** Insight IDs for continuous analysis */
    insights: z.array(z.string().min(1)).optional(),
    /** Clustering configuration (requires insights) */
    clusteringConfig: ClusteringConfigSchema.optional(),
    /** Sampling rate as a percentage (0.01 to 100) */
    samplingRate: z.number().min(0.01).max(100),
    /** Optional description for the online eval config */
    description: z.string().max(200).optional(),
    /** Whether to enable execution on create (default: true) */
    enableOnCreate: z.boolean().optional(),
    tags: TagsSchema.optional(),
  })
  .refine(data => data.agent ?? data.logGroupNames, {
    message: 'Either "agent" or "logGroupNames" must be provided',
  })
  .refine(data => !(data.agent && data.logGroupNames), {
    message: '"agent" and "logGroupNames" are mutually exclusive',
  })
  .refine(data => !data.endpoint || data.agent, {
    message: '"endpoint" requires "agent"',
  })
  .refine(data => !data.serviceNames || data.logGroupNames, {
    message: '"serviceNames" requires "logGroupNames"',
  })
  .refine(
    data => {
      const hasEvaluators = data.evaluators != null && data.evaluators.length > 0;
      const hasInsights = data.insights != null && data.insights.length > 0;
      return hasEvaluators || hasInsights;
    },
    { message: 'At least one of evaluators or insights must be provided' }
  )
  .refine(data => !(data.evaluators && data.evaluators.length > 0 && data.insights && data.insights.length > 0), {
    message: 'Cannot have both evaluators and insights (preview constraint)',
  })
  .refine(data => !data.clusteringConfig || (data.insights && data.insights.length > 0), {
    message: 'clusteringConfig requires insights to be set',
  });

export type OnlineEvalConfig = z.infer<typeof OnlineEvalConfigSchema>;
