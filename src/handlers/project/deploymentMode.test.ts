import { describe, expect, test } from "bun:test";
import { ProjectSpecSchema } from "../../projectSchemas/project";
import { FeatureFlagsKey, ValueContext, type Context } from "../../router";
import { TestFeatureFlags } from "../../testing";
import { imperativeDeployNotApplicable, resolveDeploymentMode } from "./deploymentMode";
import type { Project } from "./types";

function project(spec: Record<string, unknown>): Project {
  return {
    name: "orders",
    rootPath: "/tmp/orders",
    spec: ProjectSpecSchema.parse({ name: "orders", version: 1, ...spec }),
  };
}

const HARNESS_ONLY = project({ harnesses: [{ name: "support", path: "app/support" }] });
const MIXED = project({
  harnesses: [{ name: "support", path: "app/support" }],
  memories: [{ name: "recall", eventExpiryDuration: 30 }],
});
const EMPTY = project({});

function ctxWith(flags?: TestFeatureFlags): Context {
  const ctx = ValueContext.EmptyContext();
  return flags ? ctx.withValue(FeatureFlagsKey, flags) : ctx;
}

describe("resolveDeploymentMode", () => {
  test("is imperative only when the flag is on and the project is harness-only", () => {
    const on = ctxWith(new TestFeatureFlags(["imperativeDeploy"]));
    expect(resolveDeploymentMode(on, HARNESS_ONLY)).toBe("imperative");
    expect(resolveDeploymentMode(on, MIXED)).toBe("cdk");
  });

  // `project remove all` (or removing the last harness) leaves nothing declared;
  // the deploy that follows is the teardown, and it must reach the backend that
  // knows what the target holds — the mode guard sorts out a mismatch.
  test("is imperative for an emptied project when the flag is on", () => {
    const on = ctxWith(new TestFeatureFlags(["imperativeDeploy"]));
    expect(resolveDeploymentMode(on, EMPTY)).toBe("imperative");
    expect(resolveDeploymentMode(ctxWith(new TestFeatureFlags()), EMPTY)).toBe("cdk");
  });

  test("is cdk when the flag is off", () => {
    const off = ctxWith(new TestFeatureFlags());
    expect(resolveDeploymentMode(off, HARNESS_ONLY)).toBe("cdk");
    expect(resolveDeploymentMode(off, MIXED)).toBe("cdk");
  });

  test("is cdk when no flags are on the context at all", () => {
    expect(resolveDeploymentMode(ctxWith(), HARNESS_ONLY)).toBe("cdk");
  });
});

describe("imperativeDeployNotApplicable", () => {
  test("explains the fallback only when the flag is on for a non-harness-only project", () => {
    const on = ctxWith(new TestFeatureFlags(["imperativeDeploy"]));
    expect(imperativeDeployNotApplicable(on, MIXED)).toContain(
      "imperative deploy applies only to harness-only projects",
    );
    expect(imperativeDeployNotApplicable(on, MIXED)).toContain("project 'orders'");
    expect(imperativeDeployNotApplicable(on, HARNESS_ONLY)).toBeUndefined();
    expect(imperativeDeployNotApplicable(on, EMPTY)).toBeUndefined();
    expect(imperativeDeployNotApplicable(ctxWith(new TestFeatureFlags()), MIXED)).toBeUndefined();
    expect(imperativeDeployNotApplicable(ctxWith(), MIXED)).toBeUndefined();
  });
});
