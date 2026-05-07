import { z } from 'zod';

// ============================================================================
// HTTP Gateway Types
// ============================================================================

export const HttpGatewayNameSchema = z
  .string()
  .min(1, 'Name is required')
  .regex(
    /^[a-zA-Z][a-zA-Z0-9-]*$/,
    'Gateway name must start with a letter and contain only alphanumeric characters or hyphens (combined with project name must fit 48-char AWS limit)'
  );

export const HttpGatewayTargetSchema = z.object({
  /** Gateway target name (referenced by AB test variants) */
  name: z.string().min(1).max(100),
  /** Reference to a runtime name from spec.runtimes */
  runtimeRef: z.string().min(1),
  /** Endpoint qualifier on the runtime (e.g., 'prod', 'staging'). Defaults to 'DEFAULT'. */
  qualifier: z.string().min(1).default('DEFAULT'),
});

export type HttpGatewayTarget = z.infer<typeof HttpGatewayTargetSchema>;

export const HttpGatewaySchema = z
  .object({
    /** Unique name for the HTTP gateway */
    name: HttpGatewayNameSchema,
    /** Optional description */
    description: z.string().min(1).max(200).optional(),
    /** Reference to a runtime name from spec.runtimes. One target is created per gateway pointing to this runtime. */
    runtimeRef: z.string().min(1),
    /** IAM role ARN for gateway execution. Auto-created if omitted. */
    roleArn: z.string().min(1).optional(),
    /** Additional targets for the gateway (for target-based AB testing). */
    targets: z.array(HttpGatewayTargetSchema).optional(),
  })
  .strict();

export type HttpGateway = z.infer<typeof HttpGatewaySchema>;
