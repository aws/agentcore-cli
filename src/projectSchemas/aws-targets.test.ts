import { describe, expect, test } from "bun:test";
import { AwsTargetsSchema } from "./aws-targets";

describe("AwsTargetsSchema", () => {
  test("accepts a target naming an account and a region", () => {
    const targets = [{ name: "default", account: "111122223333", region: "us-east-1" }];

    expect(AwsTargetsSchema.parse(targets)).toEqual(targets);
  });

  test.each([
    ["a digit short", "11112222333"],
    ["a digit long", "1111222233334"],
    ["punctuated", "1111-2222-3333"],
    ["an account alias", "my-account"],
    ["empty", ""],
  ])("rejects an account that is %s", (_, account) => {
    // Deploy turns this straight into `aws://<account>/<region>`, so catching a typo here
    // fails the file that holds it instead of failing inside the CDK toolkit minutes in.
    expect(() =>
      AwsTargetsSchema.parse([{ name: "default", account, region: "us-east-1" }]),
    ).toThrow(/12-digit AWS account ID/);
  });
});
