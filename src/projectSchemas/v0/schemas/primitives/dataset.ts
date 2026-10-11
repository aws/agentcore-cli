import { z } from 'zod';

// ============================================================================
// Dataset Types
// ============================================================================

/**
 * Dataset name validation.
 * Pattern: ^[a-zA-Z][a-zA-Z0-9_]{0,47}$
 */
export const DatasetNameSchema = z
  .string()
  .min(1, 'Dataset name is required')
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

/**
 * Versioned schema type governing the structure of dataset examples.
 * Immutable after creation (createOnly CFN property).
 */
export const DatasetSchemaTypeSchema = z.enum([
  'AGENTCORE_EVALUATION_PREDEFINED_V1',
  'AGENTCORE_EVALUATION_SIMULATED_V1',
]);

export type DatasetSchemaType = z.infer<typeof DatasetSchemaTypeSchema>;

/**
 * Managed dataset config — CLI manages the local file and syncs to service.
 */
export const DatasetManagedConfigSchema = z.object({
  location: z.string().min(1),
});

/**
 * Dataset configuration.
 */
export const DatasetConfigSchema = z.object({
  managed: DatasetManagedConfigSchema,
});

/**
 * Dataset specification in agentcore.json.
 */
export const DatasetSchema = z.object({
  /** Dataset name */
  name: DatasetNameSchema,
  /**
   * Versioned schema type governing dataset structure.
   * Immutable after creation.
   */
  schemaType: DatasetSchemaTypeSchema,
  /** Optional description (max 200 characters) */
  description: z.string().max(200).optional(),
  /** Dataset content management config */
  config: DatasetConfigSchema,
  /** Optional KMS key ARN for SSE-KMS encryption. Immutable after creation. */
  kmsKeyArn: z
    .string()
    .regex(/^arn:aws(-[a-z]+)*:kms:[a-zA-Z0-9-]*:[0-9]{12}:key\/[a-zA-Z0-9-]{36}$/, 'Must be a valid KMS key ARN')
    .optional(),
});

export type Dataset = z.infer<typeof DatasetSchema>;
