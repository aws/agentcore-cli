import { describe, expect, test } from "bun:test";
import {
  V0AgentCoreProjectSpecSchema,
  V0AwsDeploymentTargetsSchema,
} from "../../../projectSchemas/v0";
import { rawFixture, validV0FixtureNames } from "./fixtures-test-support";

describe("vendored v0 0.31.1 schema", () => {
  test("parses every v0-valid audit fixture", () => {
    const names = validV0FixtureNames();
    expect(names.length).toBeGreaterThan(40);
    for (const name of names) {
      const result = V0AgentCoreProjectSpecSchema.safeParse(rawFixture(name));
      expect({ name, ok: result.success }).toEqual({ name, ok: true });
    }
  });

  test.each([
    "invalid_top-mcpRuntimeTools-renamed-to-toolRuntimes.json",
    "invalid_evaluator-model-3000-chars.json",
    "invalid_memory-namespaces-and-templates-both.json",
  ])("rejects %s, as v0 did", (name) => {
    expect(V0AgentCoreProjectSpecSchema.safeParse(rawFixture(name)).success).toBe(false);
  });

  test("accepts the hyphenated and case-duplicate target names v1 rejects", () => {
    for (const name of ["aws-targets_hyphen-name.json", "aws-targets_case-dup.json"]) {
      expect(V0AwsDeploymentTargetsSchema.safeParse(rawFixture(name)).success).toBe(true);
    }
  });
});
