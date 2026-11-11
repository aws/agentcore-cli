import { TagsSchema } from "./tags";
import { z } from "zod";

export const ONLINE_EVAL_MAX_EVALUATORS = 10;
export const OnlineEvalConfigNameSchema = z
  .string()
  .min(1, "Name is required")
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    "Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)",
  );
export const OnlineEvalEvaluatorsSchema = z
  .array(z.string().min(1))
  .max(ONLINE_EVAL_MAX_EVALUATORS, "At most 10 evaluators may be selected");
export const OnlineEvalConfigSchema = z
  .object({
    name: OnlineEvalConfigNameSchema,
    agent: z.string().min(1, "Agent name is required").optional(),
    endpoint: z.string().min(1).optional(),
    logGroupNames: z.array(z.string().min(1)).min(1).max(5).optional(),
    serviceNames: z.array(z.string().min(1)).min(1).optional(),
    evaluators: OnlineEvalEvaluatorsSchema.min(1, "At least one evaluator is required"),
    samplingRate: z.number().min(0.01).max(100),
    description: z.string().max(200).optional(),
    enableOnCreate: z.boolean().optional(),
    tags: TagsSchema.optional(),
  })
  .refine((data) => data.agent ?? data.logGroupNames, {
    message: 'Either "agent" or "logGroupNames" must be provided',
  })
  .refine((data) => !(data.agent && data.logGroupNames), {
    message: '"agent" and "logGroupNames" are mutually exclusive',
  })
  .refine((data) => !data.endpoint || data.agent, {
    message: '"endpoint" requires "agent"',
  })
  .refine((data) => !data.serviceNames || data.logGroupNames, {
    message: '"serviceNames" requires "logGroupNames"',
  });
export type OnlineEvalConfig = z.infer<typeof OnlineEvalConfigSchema>;
