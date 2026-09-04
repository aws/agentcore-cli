import { describe, expect, test } from "bun:test";
import { createHandler, FeatureFlagsKey, Router } from "../router";
import type { FeatureFlag } from "../featureFlags";
import { TestFeatureFlags } from "../testing";
import { withFeatureFlags } from "./withFeatureFlags";

// A leaf that reports what it sees on the context, so the test asserts the
// middleware's effect the way a real handler would observe it.
function routeAndRead(flags: TestFeatureFlags): Promise<{ seen: FeatureFlag[]; on: boolean }> {
  return new Promise((resolve, reject) => {
    const app = new Router("myapp", "test app");
    app.use(withFeatureFlags(flags));
    app.handler(
      createHandler({
        name: "leaf",
        description: "reads the feature flags",
        handle: async (ctx) => {
          const seen = ctx.require(FeatureFlagsKey);
          resolve({ seen: seen.enabled(), on: seen.isEnabled("imperativeDeploy") });
        },
      }),
    );
    app.route(["node", "myapp", "leaf"]).catch(reject);
  });
}

describe("withFeatureFlags", () => {
  test("pins the injected instance on the context for the leaf", async () => {
    const result = await routeAndRead(new TestFeatureFlags(["imperativeDeploy"]));
    expect(result).toEqual({ seen: ["imperativeDeploy"], on: true });
  });

  test("an instance with nothing enabled reports every flag off", async () => {
    const result = await routeAndRead(new TestFeatureFlags());
    expect(result).toEqual({ seen: [], on: false });
  });
});
