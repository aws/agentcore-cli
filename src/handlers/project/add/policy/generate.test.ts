import { afterEach, describe, expect, test } from "bun:test";
import {
  GetGatewayCommand,
  GetPolicyGenerationCommand,
  ListGatewaysCommand,
  ListPolicyEngineSummariesCommand,
  ListPolicyGenerationAssetsCommand,
  StartPolicyGenerationCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { PolicyClient } from "../../../../core/policy";
import type { AwsClients } from "../../../../core/types";
import { createSilentLogger, TestCoreClient } from "../../../../testing";
import { createGatewayProjectTestHarness } from "../gateway-test-support";

const { addGateway, cleanup, inProject, projectSpec, run } =
  createGatewayProjectTestHarness("policy-generate");

afterEach(cleanup);

/**
 Command-flow tests for `project add policy --generate`, driven through the real
 root handler with the real PolicyClient over a control client mocked at .send().
 These cover the client edges the TestPolicyClient-backed tests in index.test.ts
 cannot reach: deployed-resource resolution, polling, and asset parsing.
**/

function fakeClients(responses: {
  engines?: unknown;
  gateways?: unknown;
  getGateway?: unknown;
  start?: unknown;
  get?: unknown;
  assets?: unknown;
}): AwsClients {
  const control = {
    send: async (command: unknown) => {
      if (command instanceof ListPolicyEngineSummariesCommand) return responses.engines;
      if (command instanceof ListGatewaysCommand) return responses.gateways;
      if (command instanceof GetGatewayCommand) return responses.getGateway;
      if (command instanceof StartPolicyGenerationCommand) return responses.start;
      if (command instanceof GetPolicyGenerationCommand) return responses.get;
      if (command instanceof ListPolicyGenerationAssetsCommand) return responses.assets;
      throw new Error(`unexpected command: ${command?.constructor?.name}`);
    },
  };
  return { control: () => control } as unknown as AwsClients;
}

const CEDAR = "forbid (principal, action, resource is AgentCore::Gateway);";

const HAPPY = {
  engines: {
    policyEngines: [{ name: "TestProject_Guardrails", policyEngineId: "pe-abc123" }],
  },
  gateways: { items: [{ name: "TestProject-tools", gatewayId: "gw-1" }] },
  getGateway: { gatewayArn: "arn:aws:bedrock-agentcore:us-west-2:1:gateway/gw-1" },
  start: { policyGenerationId: "gen-1" },
  get: { status: "GENERATED" },
  assets: {
    policyGenerationAssets: [
      {
        definition: { cedar: { statement: CEDAR } },
        findings: [{ type: "VALID", description: "ok" }],
      },
    ],
  },
};

function coreWith(responses: Parameters<typeof fakeClients>[0]) {
  return {
    ...new TestCoreClient(),
    policy: new PolicyClient(fakeClients(responses), createSilentLogger(), 0),
  };
}

async function generate(responses: Parameters<typeof fakeClients>[0]) {
  const projectRoot = await inProject();
  await run(["add", "policy-engine", "--name", "Guardrails"]);
  await addGateway("tools");
  const io = await run(
    [
      "add",
      "policy",
      "--engine",
      "Guardrails",
      "--name",
      "Gen",
      "--generate",
      "forbid everything",
      "--gateway",
      "tools",
    ],
    undefined,
    coreWith(responses),
  );
  return { projectRoot, io };
}

describe("project add policy --generate against the control plane", () => {
  test("resolves deployed ids, prints the Cedar and findings, writes the spec", async () => {
    const { projectRoot, io } = await generate(HAPPY);

    expect(io.stderr()).toContain(`Generated Cedar policy:\n${CEDAR}`);
    expect(io.stderr()).toContain("finding [VALID]: ok");
    expect((await projectSpec(projectRoot)).policyEngines[0].policies[0]).toMatchObject({
      name: "Gen",
      statement: CEDAR,
    });
  });

  test("reads a Dogwood policy definition member", async () => {
    const { projectRoot } = await generate({
      ...HAPPY,
      assets: { policyGenerationAssets: [{ definition: { policy: { statement: CEDAR } } }] },
    });
    expect((await projectSpec(projectRoot)).policyEngines[0].policies[0]).toMatchObject({
      statement: CEDAR,
    });
  });

  test.each([
    ["engine not deployed", { ...HAPPY, engines: { policyEngines: [] } }, "is not deployed"],
    ["gateway not deployed", { ...HAPPY, gateways: { items: [] } }, "not deployed"],
    [
      "generation failed",
      { ...HAPPY, get: { status: "GENERATE_FAILED", statusReasons: ["bad input"] } },
      "bad input",
    ],
    ["no assets", { ...HAPPY, assets: { policyGenerationAssets: [] } }, "no generated policy"],
    [
      "the description is not translatable",
      {
        ...HAPPY,
        assets: {
          policyGenerationAssets: [
            {
              rawTextFragment: "do the thing",
              findings: [{ type: "INVALID", description: "Non-translatable" }],
            },
          ],
        },
      },
      "could not be translated into a Cedar policy: [INVALID] Non-translatable",
    ],
    [
      "polling exhausts while still generating",
      { ...HAPPY, get: { status: "GENERATING" } },
      "may still complete",
    ],
  ])("fails when %s", async (_label, responses, message) => {
    await expect(generate(responses)).rejects.toThrow(message);
  });
});
