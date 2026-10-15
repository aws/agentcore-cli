import z from "zod";

// The service's harnessId is a <=40-char name plus "-" and a 10-char suffix: 51 max.
export const harnessIdSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("arn:"), "must be a harness ID, not an ARN")
  .max(51);
