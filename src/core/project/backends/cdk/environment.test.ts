import { describe, expect, test } from "bun:test";
import type { Stack } from "@aws-sdk/client-cloudformation";
import { isStackNotFound, probeBootstrap, probeStack, readBootstrapState } from "./environment";
import type { CdkCredentialProvider } from "./toolkit";

const credentials: CdkCredentialProvider = async () => ({
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
});

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

    expect(isStackNotFound(notFound)).toBe(true);
    expect(
      await probeBootstrap("us-east-1", credentials, async () => {
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
      probeBootstrap("us-east-1", credentials, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  test("reads the target region with the deployment credentials", async () => {
    const regions: string[] = [];
    const providers: CdkCredentialProvider[] = [];

    await probeBootstrap("eu-west-1", credentials, async (region, provider) => {
      regions.push(region);
      providers.push(provider);
      return [stack("CREATE_COMPLETE", "30")];
    });

    expect(regions).toEqual(["eu-west-1"]);
    expect(providers).toEqual([credentials]);
  });
});

describe("probeStack", () => {
  test("reports a stack CloudFormation still holds as present", async () => {
    expect(
      await probeStack("AgentCore-orders-default", "us-east-1", credentials, async () => [
        stack("CREATE_COMPLETE"),
      ]),
    ).toBe(true);
  });

  test.each([
    // A stack part-way through a failed change is still a stack the user needs a
    // way to remove, so status must not narrow this to "healthy stacks only".
    "ROLLBACK_COMPLETE",
    "UPDATE_ROLLBACK_FAILED",
    "DELETE_FAILED",
  ] as const)("counts a stack in %s as present", async (status) => {
    expect(
      await probeStack("AgentCore-orders-default", "us-east-1", credentials, async () => [
        stack(status),
      ]),
    ).toBe(true);
  });

  test("reports a stack CloudFormation does not know about as absent", async () => {
    expect(
      await probeStack("AgentCore-orders-default", "us-east-1", credentials, async () => {
        throw Object.assign(new Error("Stack with id AgentCore-orders-default does not exist"), {
          name: "ValidationError",
        });
      }),
    ).toBe(false);
  });

  test("treats an empty response as absent rather than crashing", async () => {
    expect(
      await probeStack("AgentCore-orders-default", "us-east-1", credentials, async () => undefined),
    ).toBe(false);
  });

  // Reporting "no stack" on a permissions or throttling failure would turn a
  // teardown the user confirmed into an unexplained "add a resource" error.
  test("propagates a failure that is not a missing stack", async () => {
    const failure = Object.assign(new Error("User is not authorized"), {
      name: "AccessDeniedException",
    });

    await expect(
      probeStack("AgentCore-orders-default", "us-east-1", credentials, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });

  test("looks the stack up by name in the target region with the deployment credentials", async () => {
    const reads: { stackName: string; region: string; provider: CdkCredentialProvider }[] = [];

    await probeStack(
      "AgentCore-orders-prod",
      "eu-west-1",
      credentials,
      async (stackName, region, provider) => {
        reads.push({ stackName, region, provider });
        return [stack("CREATE_COMPLETE")];
      },
    );

    expect(reads).toEqual([
      { stackName: "AgentCore-orders-prod", region: "eu-west-1", provider: credentials },
    ]);
  });
});
