import { describe, expect, test } from "bun:test";
import { harnessIdSchema } from "./idSchema";

describe("harnessIdSchema", () => {
  test("accepts the longest ID the service issues (40-char name + 10-char suffix)", () => {
    const id = `${"a".repeat(40)}-${"B".repeat(10)}`;
    expect(id).toHaveLength(51);
    expect(harnessIdSchema.safeParse(id).success).toBe(true);
  });

  test("rejects an ARN with an ARN-specific message", () => {
    const result = harnessIdSchema.safeParse(
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:harness/MyHarness-abcdefghij",
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("must be a harness ID, not an ARN");
  });
});
