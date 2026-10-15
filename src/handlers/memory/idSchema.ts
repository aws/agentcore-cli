import z from "zod";

export const memoryIdSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("arn:"), "must be a Memory ID, not an ARN");
