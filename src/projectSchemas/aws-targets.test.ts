import { describe, expect, test } from "bun:test";
import {
  AgentCoreRegionSchema,
  AwsAccountIdSchema,
  AwsDeploymentTargetSchema,
  AwsDeploymentTargetsSchema,
  DeploymentTargetNameSchema,
} from "./aws-targets";

const target = {
  name: "default",
  description: "Default deployment target",
  account: "111122223333",
  region: "us-east-1",
} as const;

describe("AWS deployment targets", () => {
  test("accepts the scaffolded target shape", () => {
    expect(AwsDeploymentTargetSchema.parse(target)).toEqual(target);
    expect(AwsDeploymentTargetsSchema.parse([target])).toEqual([target]);
  });

  test.each([
    ["a digit short", "11112222333"],
    ["a digit long", "1111222233334"],
    ["punctuated", "1111-2222-3333"],
    ["an account alias", "my-account"],
  ])("rejects an account that is %s", (_label, account) => {
    expect(AwsAccountIdSchema.safeParse(account).success).toBe(false);
  });

  test.each(["", "1default", "-default", "_default", "has_underscore", "has spaces", "has.dots"])(
    "rejects invalid target name %j",
    (name) => {
      expect(DeploymentTargetNameSchema.safeParse(name).success).toBe(false);
    },
  );

  test.each(["prod-us", "a-b-c", "us-east-1", "trailing-"])(
    "accepts hyphenated target name %j, as the v0 CLI did",
    (name) => {
      expect(DeploymentTargetNameSchema.safeParse(name).success).toBe(true);
    },
  );

  test("enforces target name and description lengths", () => {
    expect(DeploymentTargetNameSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(DeploymentTargetNameSchema.safeParse("a".repeat(65)).success).toBe(false);
    expect(
      AwsDeploymentTargetSchema.safeParse({ ...target, description: "a".repeat(257) }).success,
    ).toBe(false);
  });

  test("accepts a region without AgentCore, leaving CloudFormation to reject it", () => {
    expect(AgentCoreRegionSchema.safeParse("ap-northeast-3").success).toBe(true);
  });

  test.each([
    ["the same name", target],
    ["a name that differs only by case", { ...target, name: "Default" }],
  ])("rejects a second target with %s", (_label, second) => {
    const result = AwsDeploymentTargetsSchema.safeParse([target, second]);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "Duplicate deployment target name (ignoring case): default",
    );
  });
});
