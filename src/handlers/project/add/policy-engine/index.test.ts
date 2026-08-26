import { afterEach, describe, expect, test } from "bun:test";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const { cleanup, inProject, projectSpec, run } =
  createGatewayProjectTestHarness("policy-engine-add");

afterEach(cleanup);

describe("project add policy-engine", () => {
  test("adds a bare policy engine", async () => {
    const projectRoot = await inProject();
    const io = await run(["add", "policy-engine", "--name", "Guardrails"]);

    expect((await projectSpec(projectRoot)).policyEngines).toEqual([
      { name: "Guardrails", policies: [] },
    ]);
    expect(io.stderr()).toContain("added Policy Engine 'Guardrails'");
  });

  test("maps scalar flags to policy engine fields", async () => {
    const projectRoot = await inProject();
    await run([
      "add",
      "policy-engine",
      "--name",
      "Guardrails",
      "--description",
      "Cedar authorization",
      "--encryption-key-arn",
      "arn:aws:kms:us-west-2:123456789012:key/abc",
      "--tags",
      "team=agents",
    ]);

    expect((await projectSpec(projectRoot)).policyEngines[0]).toEqual({
      name: "Guardrails",
      description: "Cedar authorization",
      encryptionKeyArn: "arn:aws:kms:us-west-2:123456789012:key/abc",
      tags: { team: "agents" },
      policies: [],
    });
  });

  test.each([
    ["missing --name", ["add", "policy-engine"], "required option '--name"],
    [
      "invalid name",
      ["add", "policy-engine", "--name", "9starts-with-digit"],
      "Must begin with a letter",
    ],
    ["duplicate name", ["add", "policy-engine", "--name", "Guardrails"], "already exists"],
  ])("rejects %s", async (label, args, message) => {
    await inProject();
    if (label === "duplicate name") await run(["add", "policy-engine", "--name", "Guardrails"]);
    await expect(run(args)).rejects.toThrow(message);
  });
});
