import { z } from "zod";
export const DatasetNameSchema = z
  .string()
  .min(1, "Dataset name is required")
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    "Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)",
  );
export const DatasetSchemaTypeSchema = z.enum([
  "AGENTCORE_EVALUATION_PREDEFINED_V1",
  "AGENTCORE_EVALUATION_SIMULATED_V1",
]);
export type DatasetSchemaType = z.infer<typeof DatasetSchemaTypeSchema>;
export const DatasetManagedConfigSchema = z.object({
  location: z.string().min(1),
});
export const DatasetConfigSchema = z.object({
  managed: DatasetManagedConfigSchema,
});
export const DatasetSchema = z.object({
  name: DatasetNameSchema,
  schemaType: DatasetSchemaTypeSchema,
  description: z.string().max(200).optional(),
  config: DatasetConfigSchema,
  kmsKeyArn: z
    .string()
    .regex(
      /^arn:aws(-[a-z]+)*:kms:[a-zA-Z0-9-]*:[0-9]{12}:key\/[a-zA-Z0-9-]{36}$/,
      "Must be a valid KMS key ARN",
    )
    .optional(),
});
export type Dataset = z.infer<typeof DatasetSchema>;
