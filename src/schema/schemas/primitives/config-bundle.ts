import { z } from 'zod';

// ============================================================================
// Configuration Bundle Types
// ============================================================================

export const ConfigBundleNameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(100)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,99}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 100 chars)'
  );

export const ConfigBundleDescriptionSchema = z.string().min(1).max(500).optional();

/** Freeform configuration for a single component within a bundle. */
export const ComponentConfigurationSchema = z.object({
  configuration: z.record(z.string(), z.unknown()),
});

export type ComponentConfiguration = z.infer<typeof ComponentConfigurationSchema>;

/**
 * Map of component identifier (ARN or placeholder) to its configuration.
 *
 * Keys are typically resource ARNs (runtime ARN, gateway ARN) but may use
 * placeholder tokens like `{{runtime:<runtimeName>}}` when the bundle is created
 * before deploy and ARNs are not yet available.
 */
export const ComponentConfigurationMapSchema = z.record(z.string(), ComponentConfigurationSchema);

export type ComponentConfigurationMap = z.infer<typeof ComponentConfigurationMapSchema>;

export const ConfigBundleSchema = z.object({
  name: ConfigBundleNameSchema,
  /** Discriminator required by the CDK package's schema validation. */
  type: z.literal('ConfigurationBundle').default('ConfigurationBundle'),
  description: ConfigBundleDescriptionSchema,
  /** Component configurations keyed by component ARN or placeholder. */
  components: ComponentConfigurationMapSchema,
  /** Optional branch name for versioning. */
  branchName: z.string().max(128).optional(),
  /** Optional commit message for this version. */
  commitMessage: z.string().max(500).optional(),
});

export type ConfigBundle = z.infer<typeof ConfigBundleSchema>;
