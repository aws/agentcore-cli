import { expect, test } from "bun:test";
import { runtimeLogGroup } from "./runtime";

test("runtimeLogGroup derives the fixed per-runtime endpoint path", () => {
  expect(runtimeLogGroup("my_agent-AbC123XyZ9", "DEFAULT")).toBe(
    "/aws/bedrock-agentcore/runtimes/my_agent-AbC123XyZ9-DEFAULT",
  );
});
