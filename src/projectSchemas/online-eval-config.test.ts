import { describe, expect, it } from "bun:test";
import { OnlineEvalConfigSchema } from "./online-eval-config";
const base = {
  name: "quality",
  samplingRate: 10,
  evaluators: ["Builtin.Helpfulness"],
};
describe("online evaluation custom validation", () => {
  it("requires exactly one data source", () => {
    expect(OnlineEvalConfigSchema.safeParse(base).success).toBe(false);
    expect(OnlineEvalConfigSchema.safeParse({ ...base, agent: "agent" }).success).toBe(true);
    expect(
      OnlineEvalConfigSchema.safeParse({
        ...base,
        agent: "agent",
        logGroupNames: ["/aws/app"],
      }).success,
    ).toBe(false);
  });
  it("binds endpoint and service filters to their corresponding data sources", () => {
    expect(
      OnlineEvalConfigSchema.safeParse({
        ...base,
        logGroupNames: ["/aws/app"],
        endpoint: "prod",
      }).success,
    ).toBe(false);
    expect(
      OnlineEvalConfigSchema.safeParse({ ...base, agent: "agent", serviceNames: ["service"] })
        .success,
    ).toBe(false);
  });
  it("requires at least one evaluator", () => {
    const source = { ...base, agent: "agent" };
    expect(OnlineEvalConfigSchema.safeParse({ ...source, evaluators: [] }).success).toBe(false);
    expect(OnlineEvalConfigSchema.safeParse({ ...source, evaluators: undefined }).success).toBe(
      false,
    );
  });
  it("limits online evaluations to ten evaluators", () => {
    const source = { ...base, agent: "agent" };
    expect(
      OnlineEvalConfigSchema.safeParse({
        ...source,
        evaluators: Array.from({ length: 10 }, (_, index) => `Builtin.Evaluator${index}`),
      }).success,
    ).toBe(true);
    expect(
      OnlineEvalConfigSchema.safeParse({
        ...source,
        evaluators: Array.from({ length: 11 }, (_, index) => `Builtin.Evaluator${index}`),
      }).success,
    ).toBe(false);
  });
});
