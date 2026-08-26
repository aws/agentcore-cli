import { afterEach, describe, expect, test } from "bun:test";
import { createGatewayProjectTestHarness } from "../gateway-test-support";
import { inferAuthorizationPhase } from "./index";

const { cleanup, inProject, projectSpec, run } = createGatewayProjectTestHarness("policy-add");

afterEach(cleanup);

const FORBID_ALL = "forbid (principal, action, resource);";
const SUPPRESS =
  "suppressOutput (principal, action, resource is AgentCore::Gateway)\n" +
  'when guardrails { BedrockGuardrails::ContentFilter(["HATE"], [context.output.message])' +
  '["HATE"].confidenceScore.greaterThan(decimal("0.2")) };';

async function withEngine(): Promise<string> {
  const projectRoot = await inProject();
  await run(["add", "policy-engine", "--name", "Guardrails"]);
  return projectRoot;
}

describe("inferAuthorizationPhase", () => {
  test.each([
    [FORBID_ALL, "INITIATE"],
    [SUPPRESS, "RETURN_OUTPUT"],
    ["permit (principal, action, resource) when { context.output.done };", "RETURN_OUTPUT"],
  ])("classifies %s", (statement, phase) => {
    expect(inferAuthorizationPhase(statement)).toBe(phase);
  });
});

describe("project add policy", () => {
  test("adds an inline statement policy with defaults", async () => {
    const projectRoot = await withEngine();
    const io = await run([
      "add",
      "policy",
      "--engine",
      "Guardrails",
      "--name",
      "DenyAll",
      "--statement",
      FORBID_ALL,
    ]);

    expect((await projectSpec(projectRoot)).policyEngines[0].policies).toEqual([
      {
        name: "DenyAll",
        statement: FORBID_ALL,
        validationMode: "FAIL_ON_ANY_FINDINGS",
        enforcementMode: "ACTIVE",
        authorizationPhase: "INITIATE",
      },
    ]);
    expect(io.stderr()).toContain("added Policy 'DenyAll' to Policy Engine 'Guardrails'");
  });

  test("reads the statement from stdin and maps mode flags", async () => {
    const projectRoot = await withEngine();
    await run(
      [
        "add",
        "policy",
        "--engine",
        "Guardrails",
        "--name",
        "Suppress",
        "--statement",
        "-",
        "--validation-mode",
        "ignore-all-findings",
        "--enforcement-mode",
        "log-only",
      ],
      SUPPRESS,
    );

    expect((await projectSpec(projectRoot)).policyEngines[0].policies[0]).toMatchObject({
      validationMode: "IGNORE_ALL_FINDINGS",
      enforcementMode: "LOG_ONLY",
      authorizationPhase: "RETURN_OUTPUT",
    });
  });

  test("records sourceFile and lets --authorization-phase override inference", async () => {
    const projectRoot = await withEngine();
    const cedarPath = `${projectRoot}/deny.cedar`;
    await Bun.write(cedarPath, FORBID_ALL);

    await run([
      "add",
      "policy",
      "--engine",
      "Guardrails",
      "--name",
      "FromFile",
      "--statement",
      `file://${cedarPath}`,
      "--authorization-phase",
      "return-output",
    ]);

    expect((await projectSpec(projectRoot)).policyEngines[0].policies[0]).toMatchObject({
      statement: FORBID_ALL,
      sourceFile: cedarPath,
      authorizationPhase: "RETURN_OUTPUT",
    });
  });

  test.each([
    ["missing --engine", ["add", "policy", "--name", "P", "--statement", FORBID_ALL], "--engine"],
    [
      "missing --name",
      ["add", "policy", "--engine", "Guardrails", "--statement", FORBID_ALL],
      "--name",
    ],
    [
      "no statement source",
      ["add", "policy", "--engine", "Guardrails", "--name", "P"],
      "one of '--statement' or '--generate'",
    ],
    [
      "unknown engine",
      ["add", "policy", "--engine", "Missing", "--name", "P", "--statement", FORBID_ALL],
      "policy engine 'Missing' does not exist",
    ],
    [
      "--gateway without --generate",
      [
        "add",
        "policy",
        "--engine",
        "Guardrails",
        "--name",
        "P",
        "--statement",
        FORBID_ALL,
        "--gateway",
        "tools",
      ],
      "--gateway is valid only with --generate",
    ],
  ])("rejects %s", async (_label, args, message) => {
    await withEngine();
    await expect(run(args)).rejects.toThrow(message);
  });

  test("rejects a duplicate policy name across engines", async () => {
    await withEngine();
    await run(["add", "policy-engine", "--name", "Second"]);
    await run([
      "add",
      "policy",
      "--engine",
      "Guardrails",
      "--name",
      "DenyAll",
      "--statement",
      FORBID_ALL,
    ]);
    await expect(
      run(["add", "policy", "--engine", "Second", "--name", "DenyAll", "--statement", FORBID_ALL]),
    ).rejects.toThrow("already exists in policy engine 'Guardrails'");
  });
});
