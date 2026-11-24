import { describe, expect, it } from "bun:test";
import {
  CodeBasedConfigSchema,
  EvaluatorConfigSchema,
  EvaluatorModelProviderSchema,
  LlmAsAJudgeConfigSchema,
  RatingScaleSchema,
  isValidBedrockModelId,
  isValidKmsKeyArn,
  isValidOpenResponsesModelId,
} from "./evaluator";
const numerical = [{ value: 1, label: "bad", definition: "Bad response" }];
const categorical = [{ label: "pass", definition: "Passes" }];
const dimension = (dimensionRatingScale: object, dimensionName = "Accuracy") => ({
  dimensionName,
  dimensionInstruction: "Is the answer correct?",
  dimensionRatingScale,
});
describe("evaluator custom validation", () => {
  it("requires exactly one rating scale representation", () => {
    expect(RatingScaleSchema.safeParse({ numerical }).success).toBe(true);
    expect(RatingScaleSchema.safeParse({ numerical, categorical }).success).toBe(false);
    expect(RatingScaleSchema.safeParse({}).success).toBe(false);
  });
  it("accepts a multiDimensional scale and rejects it alongside another representation", () => {
    const multiDimensional = [dimension({ numerical }), dimension({ categorical }, "Tone")];
    expect(RatingScaleSchema.safeParse({ multiDimensional }).success).toBe(true);
    expect(RatingScaleSchema.safeParse({ numerical, multiDimensional }).success).toBe(false);
    expect(RatingScaleSchema.safeParse({ multiDimensional: [] }).success).toBe(false);
    expect(
      RatingScaleSchema.safeParse({ multiDimensional: [dimension({ numerical, categorical })] })
        .success,
    ).toBe(false);
    const neither = RatingScaleSchema.safeParse({ multiDimensional: [dimension({})] });
    expect(neither.error?.issues[0]?.message).toBe(
      "Dimension rating scale must have exactly one of numerical or categorical",
    );
  });
  it("enforces the service's dimension limits", () => {
    const named = (dimensionName: string) => dimension({ categorical }, dimensionName);
    const rejects = (multiDimensional: object[]) =>
      expect(RatingScaleSchema.safeParse({ multiDimensional }).success).toBe(false);
    rejects([named("1st")]);
    rejects([named("Tone"), named("Tone")]);
    rejects(Array.from({ length: 51 }, (_, i) => named(`D${i}`)));
    rejects([{ ...named("Tone"), dimensionInstruction: "x".repeat(4001) }]);
    rejects([{ ...named("Tone"), dimensionInstruction: "   " }]);
    const blank = RatingScaleSchema.safeParse({
      multiDimensional: [dimension({ categorical: [{ label: "pass", definition: " " }] })],
    });
    expect(blank.error?.issues[0]?.message).toBe("Dimension rating definition must not be blank");
    rejects([dimension({ numerical: [{ value: 1, label: " ", definition: "Bad" }] })]);
  });
  it("accepts non-negative decimal values in a dimension and rejects negatives and empty lists", () => {
    const values = (...vs: number[]) =>
      vs.map((value) => ({ value, label: `L${value}`, definition: "d" }));
    expect(
      RatingScaleSchema.safeParse({
        multiDimensional: [dimension({ numerical: values(1, 0.5, 0) })],
      }).success,
    ).toBe(true);
    const rejects = (dimensionRatingScale: object) =>
      expect(
        RatingScaleSchema.safeParse({ multiDimensional: [dimension(dimensionRatingScale)] })
          .success,
      ).toBe(false);
    rejects({ numerical: values(-1) });
    rejects({ numerical: [] });
    rejects({ categorical: [] });
  });
  it("rejects unknown keys inside a dimension", () => {
    const issue = (multiDimensional: object[]) =>
      RatingScaleSchema.safeParse({ multiDimensional }).error?.issues[0];
    expect(issue([{ ...dimension({ categorical }), weight: 2 }])?.code).toBe("unrecognized_keys");
    expect(issue([dimension({ multiDimensional: [dimension({ categorical })] })])?.code).toBe(
      "unrecognized_keys",
    );
    expect(issue([dimension({ categorical: [{ ...categorical[0], score: 1 }] })])?.code).toBe(
      "unrecognized_keys",
    );
    expect(issue([dimension({ numerical: [{ ...numerical[0], weight: 1 }] })])?.code).toBe(
      "unrecognized_keys",
    );
  });
  it("leaves single-scale rules unchanged", () => {
    expect(
      RatingScaleSchema.safeParse({ numerical: [{ ...numerical[0], weight: 1 }] }).success,
    ).toBe(true);
    expect(
      RatingScaleSchema.safeParse({ numerical: [{ ...numerical[0], value: 0.5 }] }).success,
    ).toBe(false);
    expect(
      RatingScaleSchema.safeParse({ categorical: [{ label: "pass", definition: " " }] }).success,
    ).toBe(true);
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
  it("keeps modelProvider optional and defaults existing Bedrock configs unchanged", () => {
    const bedrockNoProvider = {
      model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      instructions: "Judge",
      ratingScale: { numerical },
    };
    expect(LlmAsAJudgeConfigSchema.safeParse(bedrockNoProvider).success).toBe(true);
    expect(
      LlmAsAJudgeConfigSchema.safeParse({ ...bedrockNoProvider, modelProvider: "Bedrock" }).success,
    ).toBe(true);
    expect(
      LlmAsAJudgeConfigSchema.safeParse({
        modelProvider: "OpenResponses",
        model: "openai.gpt-5.4",
        instructions: "Judge",
        ratingScale: { numerical },
      }).success,
    ).toBe(true);
  });
  it("rejects unknown model providers", () => {
    expect(EvaluatorModelProviderSchema.safeParse("Bedrock").success).toBe(true);
    expect(EvaluatorModelProviderSchema.safeParse("OpenResponses").success).toBe(true);
    expect(EvaluatorModelProviderSchema.safeParse("OpenAI").success).toBe(false);
  });
  it("validates OpenResponses model ids as non-empty printable identifiers without spaces", () => {
    expect(isValidOpenResponsesModelId("openai.gpt-5.4")).toBe(true);
    expect(isValidOpenResponsesModelId("some/model-id_v2")).toBe(true);
    expect(isValidOpenResponsesModelId("has space")).toBe(false);
    expect(isValidOpenResponsesModelId("")).toBe(false);
  });
  it("validates model identifiers and KMS key ARNs through owned helpers", () => {
    expect(isValidBedrockModelId("anthropic.claude-v2:1")).toBe(true);
    expect(isValidBedrockModelId("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(true);
    // foundation-model ARNs omit the account segment; (application-)inference-profile
    // ARNs carry it. Each type must match only its documented shape.
    expect(
      isValidBedrockModelId("arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-v2"),
    ).toBe(true);
    expect(
      isValidBedrockModelId(
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-v2",
      ),
    ).toBe(true);
    expect(
      isValidBedrockModelId(
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
      ),
    ).toBe(true);
    // Wrong account format for the resource type is rejected.
    expect(isValidBedrockModelId("arn:aws:bedrock:us-east-1:123456789012:foundation-model/x")).toBe(
      false,
    );
    expect(isValidBedrockModelId("arn:aws:bedrock:us-east-1::inference-profile/x")).toBe(false);
    expect(isValidBedrockModelId("not a model")).toBe(false);
    expect(
      isValidKmsKeyArn(
        "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012",
      ),
    ).toBe(true);
    expect(isValidKmsKeyArn("arn:aws:kms:us-east-1:123456789012:alias/example")).toBe(false);
  });
});
