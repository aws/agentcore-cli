import { describe, expect, test } from "bun:test";
import {
  GetGatewayCommand,
  GetPolicyGenerationCommand,
  ListGatewaysCommand,
  ListPolicyEngineSummariesCommand,
  ListPolicyGenerationAssetsCommand,
  StartPolicyGenerationCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { PolicyClient } from "./policy";
import { createSilentLogger } from "../testing";
import type { AwsClients } from "./types";

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

const HAPPY = {
  engines: {
    policyEngines: [{ name: "Proj_Guardrails", policyEngineId: "pe-abc123" }],
  },
  gateways: { items: [{ name: "Proj-tools", gatewayId: "gw-1" }] },
  getGateway: { gatewayArn: "arn:aws:bedrock-agentcore:us-west-2:1:gateway/gw-1" },
  start: { policyGenerationId: "gen-1" },
  get: { status: "GENERATED" },
  assets: {
    policyGenerationAssets: [
      {
        definition: { cedar: { statement: "forbid (principal, action, resource);" } },
        findings: [{ type: "VALID", description: "ok" }],
      },
    ],
  },
};

async function drain(client: PolicyClient, input: Parameters<PolicyClient["generatePolicy"]>[0]) {
  const generator = client.generatePolicy(input, { region: "us-west-2" });
  const messages: string[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { messages, result: next.value };
    messages.push(next.value.message);
  }
}

describe("PolicyClient.generatePolicy", () => {
  const input = {
    engineName: "Guardrails",
    gatewayName: "tools",
    engineServiceName: "Proj_Guardrails",
    gatewayServiceName: "Proj-tools",
    description: "block hate speech",
  };

  function client(responses: Parameters<typeof fakeClients>[0]) {
    return new PolicyClient(fakeClients(responses), createSilentLogger(), 0);
  }

  test("resolves deployed ids, generates, and returns statement with findings", async () => {
    const { messages, result } = await drain(client(HAPPY), input);

    expect(result.statement).toBe("forbid (principal, action, resource);");
    expect(result.findings).toEqual([{ type: "VALID", description: "ok" }]);
    expect(messages.some((message) => message.includes("Generating"))).toBe(true);
  });

  test("reads a Dogwood policy definition member", async () => {
    const { result } = await drain(
      client({
        ...HAPPY,
        assets: {
          policyGenerationAssets: [
            { definition: { policy: { statement: "forbid (principal, action, resource);" } } },
          ],
        },
      }),
      input,
    );
    expect(result.statement).toBe("forbid (principal, action, resource);");
    expect(result.findings).toEqual([]);
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
      "polling exhausts while still generating",
      { ...HAPPY, get: { status: "GENERATING" } },
      "may still complete",
    ],
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
  ])("fails when %s", async (_label, responses, message) => {
    await expect(drain(client(responses), input)).rejects.toThrow(message);
  });
});
