import { test, expect, describe } from "bun:test";
import { createRootHandler } from "./index";
import { createSilentLogger, TestCoreClient, TestGlobalConfigAccessor, testIO } from "../testing";

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
});
