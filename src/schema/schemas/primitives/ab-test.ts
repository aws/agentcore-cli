import { z } from 'zod';

// ============================================================================
// AB Test Types
// ============================================================================

export const ABTestNameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

export const ABTestDescriptionSchema = z.string().min(1).max(200).optional();

export const ABTestModeSchema = z.enum(['config-bundle', 'target-based']).optional().default('config-bundle');

export type ABTestMode = z.infer<typeof ABTestModeSchema>;

export const VariantNameSchema = z.enum(['C', 'T1']);

export const VariantWeightSchema = z.number().int().min(1).max(100);

// ── Config Bundle variant configuration ────────────────────────────────────

export const ConfigurationBundleRefSchema = z.object({
  bundleArn: z.string().min(1),
  bundleVersion: z.string().min(1),
});

export type ConfigurationBundleRef = z.infer<typeof ConfigurationBundleRefSchema>;

// ── Target-based variant configuration ─────────────────────────────────────

export const TargetRefSchema = z.object({
  targetName: z.string().min(1).max(100),
});

export type TargetRef = z.infer<typeof TargetRefSchema>;

// ── Variant configuration union ────────────────────────────────────────────
// Exactly one of configurationBundle or target must be set (XOR).

const ConfigBundleVariantConfigSchema = z.object({
  configurationBundle: ConfigurationBundleRefSchema,
  target: z.never().optional(),
});

const TargetVariantConfigSchema = z.object({
  configurationBundle: z.never().optional(),
  target: TargetRefSchema,
});

export const VariantConfigurationSchema = z.union([ConfigBundleVariantConfigSchema, TargetVariantConfigSchema]);

export type VariantConfiguration = z.infer<typeof VariantConfigurationSchema>;

export const ABTestVariantSchema = z.object({
  name: VariantNameSchema,
  weight: VariantWeightSchema,
  variantConfiguration: VariantConfigurationSchema,
});

export type ABTestVariant = z.infer<typeof ABTestVariantSchema>;

// ── Evaluation config union ────────────────────────────────────────────────

export const PerVariantOnlineEvaluationConfigSchema = z.object({
  treatmentName: VariantNameSchema,
  onlineEvaluationConfigArn: z.string().min(1),
});

export type PerVariantOnlineEvaluationConfig = z.infer<typeof PerVariantOnlineEvaluationConfigSchema>;

export const ABTestEvaluationConfigSchema = z.union([
  z.object({ onlineEvaluationConfigArn: z.string().min(1) }),
  z.object({
    perVariantOnlineEvaluationConfig: z.array(PerVariantOnlineEvaluationConfigSchema).length(2),
  }),
]);

export type ABTestEvaluationConfig = z.infer<typeof ABTestEvaluationConfigSchema>;

// ── Gateway filter ─────────────────────────────────────────────────────────

export const GatewayFilterSchema = z.object({
  targetPaths: z.array(z.string().min(1).max(500)).max(1),
});

export type GatewayFilter = z.infer<typeof GatewayFilterSchema>;

// ── Traffic allocation ─────────────────────────────────────────────────────

export const TrafficRouteOnHeaderSchema = z.object({
  headerName: z.string().min(1),
});

export const TrafficAllocationConfigSchema = z.object({
  routeOnHeader: TrafficRouteOnHeaderSchema,
});

export type TrafficAllocationConfig = z.infer<typeof TrafficAllocationConfigSchema>;

// ── AB Test schema ─────────────────────────────────────────────────────────

export const ABTestSchema = z
  .object({
    name: ABTestNameSchema,
    description: ABTestDescriptionSchema,
    mode: ABTestModeSchema,
    gatewayRef: z.string().min(1),
    roleArn: z.string().min(1).optional(),
    variants: z.array(ABTestVariantSchema).length(2),
    evaluationConfig: ABTestEvaluationConfigSchema,
    gatewayFilter: GatewayFilterSchema.optional(),
    trafficAllocationConfig: TrafficAllocationConfigSchema.optional(),
    maxDurationDays: z.number().int().min(1).max(90).optional(),
    enableOnCreate: z.boolean().optional(),
    promoted: z.boolean().optional(),
  })
  .refine(
    data => {
      const names = data.variants.map(v => v.name);
      return names.includes('C') && names.includes('T1');
    },
    { message: 'Variants must include exactly one control (C) and one treatment (T1)', path: ['variants'] }
  )
  .refine(data => data.variants.reduce((sum, v) => sum + v.weight, 0) === 100, {
    message: 'Variant weights must sum to 100',
    path: ['variants'],
  })
  .refine(
    data => {
      if (data.mode === 'target-based') {
        return data.variants.every(v => v.variantConfiguration.target != null);
      }
      return data.variants.every(v => v.variantConfiguration.configurationBundle != null);
    },
    {
      message: 'Target-based mode requires target on each variant; config-bundle mode requires configurationBundle',
      path: ['variants'],
    }
  );

export type ABTest = z.infer<typeof ABTestSchema>;
