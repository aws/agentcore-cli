import { describe, expect, test } from "bun:test";
import { toStackName } from "../../assets/cdk/lib/names";

describe("toStackName", () => {
  test("uses the shared CDK stack naming contract", () => {
    expect(toStackName("my_project", "us_west_2")).toBe("AgentCore-my-project-us-west-2");
  });
});
