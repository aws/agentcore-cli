import { test, expect } from "bun:test";
import { BatchEvaluationNameSchema } from "./batch-evaluation";

test("BatchEvaluationNameSchema accepts letters, digits and underscores", () => {
  expect(BatchEvaluationNameSchema.safeParse("nightly_regression_1").success).toBe(true);
});

test("BatchEvaluationNameSchema rejects hyphens, a leading digit, and empty", () => {
  expect(BatchEvaluationNameSchema.safeParse("nightly-regression").success).toBe(false);
  expect(BatchEvaluationNameSchema.safeParse("1nightly").success).toBe(false);
  expect(BatchEvaluationNameSchema.safeParse("").success).toBe(false);
});
