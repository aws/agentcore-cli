import { HarnessSpecSchema as PublishedHarnessSpecSchema } from '@aws/agentcore-cdk';
import { z } from 'zod';

// Match CLI strictness and literal prompt policy while retaining the published object refinements.
export const HarnessSpecSchema: typeof PublishedHarnessSpecSchema = PublishedHarnessSpecSchema.strict().safeExtend({
  model: PublishedHarnessSpecSchema.shape.model.strict(),
  systemPrompt: z.string()
    .refine(val => val.trim().length > 0, { message: 'systemPrompt must not be empty or whitespace-only' })
    .optional(),
});
