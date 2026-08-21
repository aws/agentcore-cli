import { KmsKeyArnSchema } from "./evaluator";
import { z } from "zod";
export const ConfigBundleNameSchema = z
  .string()
  .min(1, "Name is required")
  .max(100)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,99}$/,
    "Must begin with a letter and contain only alphanumeric characters and underscores (max 100 chars)",
  );
export const ConfigBundleDescriptionSchema = z.string().min(1).max(500).optional();
export const ComponentConfigurationSchema = z.object({
  configuration: z.record(z.string(), z.unknown()),
});
export type ComponentConfiguration = z.infer<typeof ComponentConfigurationSchema>;
export const ComponentConfigurationMapSchema = z.record(z.string(), ComponentConfigurationSchema);
export type ComponentConfigurationMap = z.infer<typeof ComponentConfigurationMapSchema>;
export const ConfigBundleBranchNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z][a-zA-Z0-9_/-]{0,127}$/, "Value must match [a-zA-Z][a-zA-Z0-9_/-]");
export const ConfigBundleCommitMessageSchema = z.string().max(500);
export const ConfigBundleSchema = z.object({
  name: ConfigBundleNameSchema,
  type: z.literal("ConfigurationBundle").default("ConfigurationBundle"),
  description: ConfigBundleDescriptionSchema,
  components: ComponentConfigurationMapSchema,
  branchName: ConfigBundleBranchNameSchema.optional(),
  commitMessage: ConfigBundleCommitMessageSchema.optional(),
  kmsKeyArn: KmsKeyArnSchema.optional(),
});
export type ConfigBundle = z.infer<typeof ConfigBundleSchema>;
