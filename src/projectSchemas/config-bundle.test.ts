import { describe, expect, test } from "bun:test";
import { ConfigBundleBranchNameSchema } from "./config-bundle";

describe("ConfigBundleBranchNameSchema", () => {
  test.each(["mainline", "feature/order-routing", "release-2026_08"])(
    "accepts service-compatible branch name %s",
    (branchName) => {
      expect(ConfigBundleBranchNameSchema.safeParse(branchName).success).toBe(true);
    },
  );

  test.each(["", "1-mainline", "feature branch", "feature.order"])(
    "rejects service-incompatible branch name %s",
    (branchName) => {
      expect(ConfigBundleBranchNameSchema.safeParse(branchName).success).toBe(false);
    },
  );

  test("enforces the service's 128-character maximum", () => {
    expect(ConfigBundleBranchNameSchema.safeParse(`a${"b".repeat(127)}`).success).toBe(true);
    expect(ConfigBundleBranchNameSchema.safeParse(`a${"b".repeat(128)}`).success).toBe(false);
  });
});
