import { describe, expect, test } from "bun:test";
import type { Stack } from "@aws-sdk/client-cloudformation";
import { describeStack, type DescribeStacks } from "./stackReader";
import type { CdkCredentialProvider } from "./toolkit";

const credentials: CdkCredentialProvider = async () => ({
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
});

function stack(name: string): Stack {
  return { StackName: name, CreationTime: new Date(0), StackStatus: "CREATE_COMPLETE" };
}

describe("describeStack", () => {
  test("returns the described stack, passing the stack name to the describer", async () => {
    const names: string[] = [];
    const describe: DescribeStacks = async (stackName) => {
      names.push(stackName);
      return [stack("AgentCore-example-prod")];
    };

    const result = await describeStack(
      "eu-west-1",
      credentials,
      "AgentCore-example-prod",
      describe,
    );

    expect(result).toEqual(stack("AgentCore-example-prod"));
    expect(names).toEqual(["AgentCore-example-prod"]);
  });

  test("returns undefined when CloudFormation reports the stack does not exist", async () => {
    const notFound = Object.assign(new Error("Stack with id missing does not exist"), {
      name: "ValidationError",
    });
    const describe: DescribeStacks = async () => {
      throw notFound;
    };

    expect(await describeStack("us-east-1", credentials, "missing", describe)).toBeUndefined();
  });

  test("returns undefined when the describer yields no stacks", async () => {
    const describe: DescribeStacks = async () => [];
    expect(await describeStack("us-east-1", credentials, "empty", describe)).toBeUndefined();
  });

  test("propagates errors other than not-found", async () => {
    const failure = Object.assign(new Error("User is not authorized"), {
      name: "AccessDeniedException",
    });
    const describe: DescribeStacks = async () => {
      throw failure;
    };

    await expect(describeStack("us-east-1", credentials, "denied", describe)).rejects.toBe(failure);
  });
});
