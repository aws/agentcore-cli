import { describe, expect, it } from "bun:test";
import { ABTestSchema } from "./ab-test";
const configurationBundle = { bundleArn: "arn:bundle", bundleVersion: "1" };
const base = {
  name: "Experiment",
  gatewayRef: "{{gateway:main}}",
  variants: [
    { name: "C", weight: 50, variantConfiguration: { configurationBundle } },
    { name: "T1", weight: 50, variantConfiguration: { configurationBundle } },
  ],
  evaluationConfig: { onlineEvaluationConfigArn: "arn:evaluation" },
};
describe("ABTestSchema custom validation", () => {
  it("requires one control and one treatment variant", () => {
    const result = ABTestSchema.safeParse({
      ...base,
      variants: base.variants.map((variant) => ({ ...variant, name: "C" })),
    });
    expect(result.success).toBe(false);
  });
  it("requires variant weights to sum to 100", () => {
    const result = ABTestSchema.safeParse({
      ...base,
      variants: [
        { ...base.variants[0], weight: 60 },
        { ...base.variants[1], weight: 60 },
      ],
    });
    expect(result.success).toBe(false);
  });
  it("binds variant configuration to the selected mode", () => {
    const targetBased = ABTestSchema.safeParse({
      ...base,
      mode: "target-based",
      variants: [
        { name: "C", weight: 50, variantConfiguration: { target: { targetName: "control" } } },
        { name: "T1", weight: 50, variantConfiguration: { target: { targetName: "treatment" } } },
      ],
    });
    expect(targetBased.success).toBe(true);
    expect(ABTestSchema.safeParse({ ...base, mode: "target-based" }).success).toBe(false);
  });
});
