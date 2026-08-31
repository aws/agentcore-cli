import { describe, expect, test } from "bun:test";
import type { CloudFormationClient, Stack } from "@aws-sdk/client-cloudformation";
import {
  bootstrapStackReader,
  createCloudFormationStackReader,
  isStackNotFound,
  probeBootstrap,
  readBootstrapState,
} from "./environment";
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

test("injects and caches CloudFormation clients by credentials and region", async () => {
  const otherCredentials: CdkCredentialProvider = async () => ({
    accessKeyId: "other-access-key",
    secretAccessKey: "other-secret-key",
  });
  const creations: { region: string; credentials: CdkCredentialProvider }[] = [];
  const stackNames: string[] = [];
  const read = createCloudFormationStackReader((config) => {
    creations.push({
      region: config.region,
      credentials: config.credentials as CdkCredentialProvider,
    });
    return {
      send: async (command: { input: { StackName?: string } }) => {
        stackNames.push(command.input.StackName ?? "");
        return { Stacks: [stack("CREATE_COMPLETE", "30")] };
      },
    } as unknown as CloudFormationClient;
  });

  await bootstrapStackReader(read)("us-east-1", credentials);
  await read("Application", "us-east-1", credentials);
  await read("Regional", "eu-west-1", credentials);
  await read("OtherCredentials", "us-east-1", otherCredentials);

  expect(creations).toEqual([
    { region: "us-east-1", credentials },
    { region: "eu-west-1", credentials },
    { region: "us-east-1", credentials: otherCredentials },
  ]);
  expect(stackNames).toEqual(["CDKToolkit", "Application", "Regional", "OtherCredentials"]);
});

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
