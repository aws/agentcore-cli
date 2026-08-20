import { describe, expect, test } from "bun:test";
import type { Stack } from "@aws-sdk/client-cloudformation";
import { isBootstrapStackNotFound, probeBootstrap, readBootstrapState } from "./environment";

function stack(status: Stack["StackStatus"], version?: string): Stack {
  return {
    StackName: "CDKToolkit",
    CreationTime: new Date(0),
    StackStatus: status,
    Outputs: version ? [{ OutputKey: "BootstrapVersion", OutputValue: version }] : [],
  };
}

describe("readBootstrapState", () => {
  test("accepts stable stacks at or above the minimum version", () => {
    expect(readBootstrapState([stack("CREATE_COMPLETE", "30")])).toEqual({
      kind: "current",
      version: 30,
    });
    expect(readBootstrapState([stack("UPDATE_ROLLBACK_COMPLETE", "99")])).toEqual({
      kind: "current",
      version: 99,
    });
  });

  test("marks stable legacy and old stacks for an upgrade", () => {
    expect(readBootstrapState([stack("UPDATE_COMPLETE")])).toEqual({
      kind: "outdated",
      version: 0,
    });
    expect(readBootstrapState([stack("UPDATE_COMPLETE", "29")])).toEqual({
      kind: "outdated",
      version: 29,
    });
  });

  test.each([
    "CREATE_IN_PROGRESS",
    "UPDATE_IN_PROGRESS",
    "DELETE_IN_PROGRESS",
    "ROLLBACK_COMPLETE",
    "ROLLBACK_FAILED",
    "UPDATE_ROLLBACK_FAILED",
    "DELETE_FAILED",
  ] as const)("refuses to repair a stack in %s", (status) => {
    expect(() => readBootstrapState([stack(status, "30")])).toThrow(new RegExp(status));
  });

  test("rejects a malformed bootstrap version", () => {
    expect(() => readBootstrapState([stack("CREATE_COMPLETE", "v30")])).toThrow(
      /invalid BootstrapVersion/,
    );
  });

  test("rejects an empty successful response", () => {
    expect(() => readBootstrapState([])).toThrow(/CloudFormation returned no stack/);
  });
});

describe("probeBootstrap", () => {
  test("treats only CloudFormation's stack-not-found response as absent", async () => {
    const notFound = Object.assign(new Error("Stack with id CDKToolkit does not exist"), {
      name: "ValidationError",
    });

    expect(isBootstrapStackNotFound(notFound)).toBe(true);
    expect(
      await probeBootstrap("us-east-1", async () => {
        throw notFound;
      }),
    ).toEqual({ kind: "absent" });
  });

  test.each([
    Object.assign(new Error("User is not authorized"), {
      name: "AccessDeniedException",
    }),
    Object.assign(new Error("Rate exceeded"), {
      name: "ThrottlingException",
    }),
    Object.assign(new Error("request timed out"), { name: "TimeoutError" }),
    Object.assign(new Error("Template format error"), {
      name: "ValidationError",
    }),
  ])("propagates %s instead of guessing the stack is absent", async (failure) => {
    await expect(
      probeBootstrap("us-east-1", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  test("reads the target region", async () => {
    const regions: string[] = [];

    await probeBootstrap("eu-west-1", async (region) => {
      regions.push(region);
      return [stack("CREATE_COMPLETE", "30")];
    });

    expect(regions).toEqual(["eu-west-1"]);
  });
});
