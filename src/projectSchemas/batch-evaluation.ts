import { z } from "zod";

// The service constrains batchEvaluationName to this pattern; mirrors the sibling
// eval resource name schemas (evaluator, online-eval-config).
export const BatchEvaluationNameSchema = z
  .string()
  .min(1, "Name is required")
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    "Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)",
  );
