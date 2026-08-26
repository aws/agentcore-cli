import { describe, expect, test } from "bun:test";
import type { Stack } from "@aws-sdk/client-cloudformation";
import { classifyStack, readStackState, type StackReader } from "./stackReader";
import type { CdkCredentialProvider } from "./toolkit";

const credentials: CdkCredentialProvider = async () => ({
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
});

function stack(status: Stack["StackStatus"], outputs?: Stack["Outputs"]): Stack {
  return {
    StackName: "AgentCore-example-default",
    CreationTime: new Date(0),
    StackStatus: status,
    ...(outputs && { Outputs: outputs }),
  };
}

describe("classifyStack", () => {
  test("treats an absent stack as not deployed", () => {
    expect(classifyStack(undefined)).toEqual({ kind: "not-deployed" });
  });

  test("treats a deleted stack (described by ARN) as not deployed", () => {
    expect(classifyStack(stack("DELETE_COMPLETE"))).toEqual({ kind: "not-deployed" });
  });

  test.each([
    "CREATE_IN_PROGRESS",
    "UPDATE_IN_PROGRESS",
    "DELETE_IN_PROGRESS",
    "REVIEW_IN_PROGRESS",
    "UPDATE_ROLLBACK_IN_PROGRESS",
  ] as const)("reports %s as in-progress", (status) => {
    expect(classifyStack(stack(status))).toEqual({ kind: "in-progress", status });
  });

  test.each([
    "ROLLBACK_COMPLETE",
    "CREATE_FAILED",
    "ROLLBACK_FAILED",
    "UPDATE_FAILED",
    "UPDATE_ROLLBACK_FAILED",
    "DELETE_FAILED",
  ] as const)("reports %s as failed", (status) => {
    expect(classifyStack(stack(status))).toEqual({ kind: "failed", status });
  });

  test.each(["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"] as const)(
    "reports %s as ready with its outputs",
    (status) => {
      const result = classifyStack(
        stack(status, [
          { OutputKey: "RuntimeArn", OutputValue: "arn:runtime" },
          { OutputKey: "MemoryId", OutputValue: "mem-123" },
        ]),
      );
      expect(result).toEqual({
        kind: "ready",
        status,
        outputs: { RuntimeArn: "arn:runtime", MemoryId: "mem-123" },
      });
    },
  );

  test("returns empty outputs when a ready stack declares none", () => {
    expect(classifyStack(stack("CREATE_COMPLETE"))).toEqual({
      kind: "ready",
      status: "CREATE_COMPLETE",
      outputs: {},
    });
  });

  test("skips partial output entries", () => {
    const result = classifyStack(
      stack("CREATE_COMPLETE", [
        { OutputKey: "RuntimeArn", OutputValue: "arn:runtime" },
        { OutputKey: "NoValue" },
        { OutputValue: "no-key" },
      ]),
    );
    expect(result).toEqual({
      kind: "ready",
      status: "CREATE_COMPLETE",
      outputs: { RuntimeArn: "arn:runtime" },
    });
  });
});

describe("readStackState", () => {
  test("classifies the stack the reader returns, passing region + credentials + name through", async () => {
    const calls: { region: string; credentials: CdkCredentialProvider; stackName: string }[] = [];
    const read: StackReader = async (region, creds, stackName) => {
      calls.push({ region, credentials: creds, stackName });
      return stack("CREATE_COMPLETE", [{ OutputKey: "RuntimeArn", OutputValue: "arn:runtime" }]);
    };

    const result = await readStackState("eu-west-1", credentials, "AgentCore-example-prod", read);

    expect(result).toEqual({
      kind: "ready",
      status: "CREATE_COMPLETE",
      outputs: { RuntimeArn: "arn:runtime" },
    });
    expect(calls).toEqual([
      { region: "eu-west-1", credentials, stackName: "AgentCore-example-prod" },
    ]);
  });

  test("maps a missing stack to not-deployed", async () => {
    const read: StackReader = async () => undefined;
    expect(await readStackState("us-east-1", credentials, "missing", read)).toEqual({
      kind: "not-deployed",
    });
  });

  test("propagates non-not-found errors from the reader", async () => {
    const failure = Object.assign(new Error("User is not authorized"), {
      name: "AccessDeniedException",
    });
    const read: StackReader = async () => {
      throw failure;
    };

    await expect(readStackState("us-east-1", credentials, "denied", read)).rejects.toBe(failure);
  });
});
