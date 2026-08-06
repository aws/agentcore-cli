import { describe, expect, it } from "bun:test";
import {
  CodeBasedConfigSchema,
  EvaluatorConfigSchema,
  RatingScaleSchema,
  isValidBedrockModelId,
  isValidKmsKeyArn,
} from "./evaluator";
const numerical = [{ value: 1, label: "bad", definition: "Bad response" }];
const categorical = [{ label: "pass", definition: "Passes" }];
describe("evaluator custom validation", () => {
  it("requires exactly one rating scale representation", () => {
    expect(RatingScaleSchema.safeParse({ numerical }).success).toBe(true);
    expect(RatingScaleSchema.safeParse({ numerical, categorical }).success).toBe(false);
    expect(RatingScaleSchema.safeParse({}).success).toBe(false);
  });
  it("requires exactly one code-based implementation", () => {
    const managed = { codeLocation: "./evaluator" };
    const external = {
      lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:evaluator",
    };
    expect(CodeBasedConfigSchema.safeParse({ managed }).success).toBe(true);
    expect(CodeBasedConfigSchema.safeParse({ managed, external }).success).toBe(false);
    expect(CodeBasedConfigSchema.safeParse({}).success).toBe(false);
  });
  it("requires exactly one evaluator configuration kind", () => {
    const llmAsAJudge = { model: "model", instructions: "Judge", ratingScale: { numerical } };
    const codeBased = { managed: { codeLocation: "./evaluator" } };
    expect(EvaluatorConfigSchema.safeParse({ llmAsAJudge }).success).toBe(true);
    expect(EvaluatorConfigSchema.safeParse({ llmAsAJudge, codeBased }).success).toBe(false);
  });
  it("validates model identifiers and KMS key ARNs through owned helpers", () => {
    expect(isValidBedrockModelId("anthropic.claude-v2:1")).toBe(true);
    expect(isValidBedrockModelId("not a model")).toBe(false);
    expect(
      isValidKmsKeyArn(
        "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012",
      ),
    ).toBe(true);
    expect(isValidKmsKeyArn("arn:aws:kms:us-east-1:123456789012:alias/example")).toBe(false);
  });
});
