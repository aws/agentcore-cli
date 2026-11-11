import { describe, expect, test } from "bun:test";
import { fakeCloudFormation } from "./migrate-test-support";
import { checkStack, cloudFormationStackReader } from "./stacks";

const reader = (stacks: Parameters<typeof fakeCloudFormation>[0]) =>
  cloudFormationStackReader(
    fakeCloudFormation(stacks).create({
      region: "us-east-1",
      credentials: { accessKeyId: "a", secretAccessKey: "b" },
    }),
  );

describe("checkStack", () => {
  test("passes a stable stack without a stack policy", async () => {
    for (const status of ["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"]) {
      expect(await checkStack(reader({ S: { status } }), "default", "S")).toEqual({
        name: "stack (default)",
        ok: true,
        message: `S is ${status}, with no stack policy`,
      });
    }
  });

  test("fails a stack that is changing, failed, or rolled back", async () => {
    const message = async (status: string) =>
      (await checkStack(reader({ S: { status } }), "default", "S")).message;
    expect(await message("UPDATE_IN_PROGRESS")).toBe(
      "Stack 'S' is UPDATE_IN_PROGRESS; it must be CREATE_COMPLETE, UPDATE_COMPLETE, IMPORT_COMPLETE. Wait for the operation in progress to finish, then try again.",
    );
    for (const status of [
      "UPDATE_ROLLBACK_COMPLETE",
      "ROLLBACK_COMPLETE",
      "UPDATE_FAILED",
      "ROLLBACK_FAILED",
      "UPDATE_ROLLBACK_IN_PROGRESS",
    ]) {
      expect(await message(status)).toStartWith(`Stack 'S' is ${status}; it must be`);
    }
    expect(await message("UPDATE_ROLLBACK_COMPLETE")).toEndWith(
      "Run `agentcore deploy` until it succeeds, then try again.",
    );
  });

  test("fails a stack with a stack policy, whatever it says", async () => {
    const check = await checkStack(
      reader({ S: { policy: '{"Statement":[{"Effect":"Allow","Action":"Update:*"}]}' } }),
      "dev",
      "S",
    );
    expect(check.ok).toBe(false);
    expect(check.name).toBe("stack (dev)");
    expect(check.message).toContain(
      "CloudFormation stack refactoring doesn't support stacks with a stack policy",
    );
  });

  test("treats an empty policy body as no policy", async () => {
    expect((await checkStack(reader({ S: { policy: "  " } }), "default", "S")).ok).toBe(true);
  });

  test("fails a stack the deployed state records but that doesn't exist", async () => {
    const check = await checkStack(reader({}), "default", "Gone");
    expect(check.ok).toBe(false);
    expect(check.message).toStartWith(
      "The deployed state records stack 'Gone' for target 'default', but it doesn't exist.",
    );
  });
});

describe("cloudFormationStackReader", () => {
  test("reads the deployed template as submitted", async () => {
    const cloudFormation = fakeCloudFormation({ S: { template: { Resources: {} } } });
    const read = cloudFormationStackReader(
      cloudFormation.create({
        region: "eu-west-1",
        credentials: { accessKeyId: "a", secretAccessKey: "b" },
      }),
    );
    expect(await read.template("S")).toEqual({ Resources: {} });
    expect(cloudFormation.calls).toEqual([
      {
        command: "GetTemplateCommand",
        input: { StackName: "S", TemplateStage: "Original" },
        region: "eu-west-1",
      },
    ]);
  });

  test("rejects a template that isn't JSON, or a missing one", async () => {
    await expect(reader({ S: { templateBody: "Resources: {}" } }).template("S")).rejects.toThrow(
      "Stack 'S' was deployed with a template that isn't JSON.",
    );
    await expect(reader({ S: { templateBody: "" } }).template("S")).rejects.toThrow(
      "CloudFormation returned no template for stack 'S'.",
    );
  });

  test("passes through errors other than a missing stack", async () => {
    const failing = cloudFormationStackReader({
      send: async () => {
        throw Object.assign(new Error("Rate exceeded"), { name: "Throttling" });
      },
    } as never);
    await expect(failing.describe("S")).rejects.toThrow("Rate exceeded");
  });
});
