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
  it("requires exactly one analysis mode and binds clustering to insights", () => {
    const source = { ...base, agent: "agent" };
    expect(
      OnlineEvalConfigSchema.safeParse({ ...source, evaluators: [], insights: [] }).success,
    ).toBe(false);
    expect(OnlineEvalConfigSchema.safeParse({ ...source, insights: ["Latency"] }).success).toBe(
      false,
    );
    expect(
      OnlineEvalConfigSchema.safeParse({
        ...source,
        evaluators: undefined,
        clusteringConfig: { frequencies: ["DAILY"] },
      }).success,
    ).toBe(false);
    expect(
      OnlineEvalConfigSchema.safeParse({
        ...source,
        evaluators: undefined,
        insights: ["Latency"],
        clusteringConfig: { frequencies: ["DAILY"] },
      }).success,
    ).toBe(true);
  });
});
