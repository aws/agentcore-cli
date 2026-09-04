import { test, expect, describe } from "bun:test";
import { createRootHandler } from "./index";
import { createHandler, FeatureFlagsKey } from "../router";
import type { FeatureFlag } from "../featureFlags";
import {
  createSilentLogger,
  TestCoreClient,
  TestFeatureFlags,
  TestGlobalConfigAccessor,
  testIO,
} from "../testing";

describe("createRootHandler", () => {
  test("builds the agentcore command tree with its subcommands", () => {
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    expect(root.name()).toBe("agentcore");
    expect(root.children().map((c) => c.name())).toEqual([
      "harness",
      "identity",
      "runtime",
      "memory",
      "gateway",
      "eval",
      "feedback",
      "config",
      "project",
      "update",
    ]);
  });

  // Every command, CLI or TUI, must be able to ask which experiments are on; the
  // flags are pinned at the root so a leaf mounted anywhere sees them.
  test("pins the injected feature flags for every command", async () => {
    let seen: FeatureFlag[] | undefined;
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
      featureFlags: new TestFeatureFlags(["imperativeDeploy"]),
    });
    root.handler(
      createHandler({
        name: "probe",
        description: "reads the flags",
        handle: async (ctx) => {
          seen = ctx.require(FeatureFlagsKey).enabled();
        },
      }),
    );

    await root.route(["node", "agentcore", "probe"]);

    expect(seen).toEqual(["imperativeDeploy"]);
  });

  test("defaults to no feature flags when the config omits them", async () => {
    let seen: FeatureFlag[] | undefined;
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    root.handler(
      createHandler({
        name: "probe",
        description: "reads the flags",
        handle: async (ctx) => {
          seen = ctx.require(FeatureFlagsKey).enabled();
        },
      }),
    );

    await root.route(["node", "agentcore", "probe"]);

    expect(seen).toEqual([]);
  });
});
