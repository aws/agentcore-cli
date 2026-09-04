import { afterEach, describe, expect, test } from "bun:test";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const { addGateway, cleanup, inProject, projectSpec, run } =
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
    [
      "a deployed name over the service limit",
      ["add", "policy-engine", "--name", `E${"x".repeat(36)}`],
      "exceeds the service limit of 48 characters",
    ],
  ])("rejects %s", async (_label, args, message) => {
    await inProject();
    await expect(run(args)).rejects.toThrow(message);
  });

  test.each([
    ["defaults to enforce", [], "ENFORCE"],
    ["honors --attach-mode log-only", ["--attach-mode", "log-only"], "LOG_ONLY"],
  ])("attaches the engine to named gateways: %s", async (_label, modeArgs, mode) => {
    const projectRoot = await inProject();
    await addGateway("tools");
    await addGateway("search");

    await run([
      "add",
      "policy-engine",
      "--name",
      "Guardrails",
      "--attach-to-gateways",
      "tools",
      "search",
      ...modeArgs,
    ]);

    const spec = await projectSpec(projectRoot);
    expect(spec.agentCoreGateways).toHaveLength(2);
    for (const gateway of spec.agentCoreGateways) {
      expect(gateway.policyEngineConfiguration).toEqual({
        policyEngineName: "Guardrails",
        mode,
      });
    }
  });

  test("--json reports gateway attachments as structured notes", async () => {
    await inProject();
    await addGateway("tools");

    const io = await run([
      "add",
      "policy-engine",
      "--name",
      "Guardrails",
      "--attach-to-gateways",
      "tools",
      "--json",
    ]);

    expect(JSON.parse(io.stdout()).notes).toEqual(["attached 'Guardrails' to 1 gateway(s)"]);
    expect(io.stderr()).not.toContain("attached 'Guardrails'");
  });

  test("rejects unknown gateway names without writing the engine", async () => {
    const projectRoot = await inProject();
    await expect(
      run(["add", "policy-engine", "--name", "Guardrails", "--attach-to-gateways", "missing"]),
    ).rejects.toThrow("gateway 'missing' does not exist");
    expect((await projectSpec(projectRoot)).policyEngines ?? []).toEqual([]);
  });

  test("rejects --attach-mode without --attach-to-gateways", async () => {
    await inProject();
    await expect(
      run(["add", "policy-engine", "--name", "Guardrails", "--attach-mode", "enforce"]),
    ).rejects.toThrow("--attach-mode requires --attach-to-gateways");
  });
});
