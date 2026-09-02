import { describe, expect, test } from "bun:test";
import {
  GetGatewayCommand,
  GetPolicyGenerationCommand,
  ListPolicyGenerationAssetsCommand,
  StartPolicyGenerationCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError, NetworkingError } from "../errors";
import type { ProgressEvent } from "../tui/progress";
import { createSilentLogger } from "../testing";
import { PolicyClient } from "./policy";
import type { AwsClients } from "./types";

const options = { region: "us-west-2" };
const GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-west-2:111122223333:gateway/gw-1";
const ATTACHED_ENGINE_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:111122223333:policy-engine/pe-attached";
const EXPLICIT_ENGINE_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:111122223333:policy-engine/pe-explicit";
const FORBID = "forbid (principal, action, resource is AgentCore::Gateway);";
const PERMIT = "permit (principal, action, resource is AgentCore::Gateway);";

type Responses = {
  getGateway?: unknown;
  start?: unknown;
  get?: unknown;
  assets?: unknown[];
};

const HAPPY: Responses = {
  getGateway: { gatewayArn: GATEWAY_ARN, policyEngineConfiguration: { arn: ATTACHED_ENGINE_ARN } },
  start: { policyGenerationId: "gen-1" },
  get: { status: "GENERATED" },
  assets: [
    {
      policyGenerationAssets: [
        {
          definition: { cedar: { statement: FORBID } },
          findings: [{ type: "DENY_ALL", description: "denies every request" }],
        },
      ],
      nextToken: "page-2",
    },
    {
      policyGenerationAssets: [{ definition: { policy: { statement: PERMIT } } }],
    },
  ],
};

function policyClient(responses: Responses, sent: { input: unknown }[] = []) {
  const assetPages = [...(responses.assets ?? [])];
  const control = {
    send: async (command: { input: unknown }) => {
      sent.push(command);
      if (command instanceof GetGatewayCommand) return responses.getGateway;
      if (command instanceof StartPolicyGenerationCommand) return responses.start;
      if (command instanceof GetPolicyGenerationCommand) return responses.get;
      if (command instanceof ListPolicyGenerationAssetsCommand) return assetPages.shift();
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
  return new PolicyClient(
    { control: () => control } as unknown as AwsClients,
    createSilentLogger(),
    { maxWaitTime: 2, minDelay: 1, maxDelay: 1 },
  );
}

async function drain<T>(generator: AsyncGenerator<ProgressEvent, T>) {
  const steps: string[] = [];
  let next = await generator.next();
  while (!next.done) {
    if (next.value.type === "step") steps.push(next.value.message);
    next = await generator.next();
  }
  return { steps, result: next.value };
}

describe("PolicyClient.generatePolicy", () => {
  test.each([
    ["the attached engine when none is given", undefined, "pe-attached"],
    ["an explicit engine ARN over the attached one", EXPLICIT_ENGINE_ARN, "pe-explicit"],
  ])("generates against %s", async (_label, policyEngineId, expectedEngineId) => {
    const sent: { input: unknown }[] = [];
    const { steps, result } = await drain(
      policyClient(HAPPY, sent).generatePolicy(
        { gatewayId: GATEWAY_ARN, policyEngineId, prompt: "deny everything", name: "gen" },
        options,
      ),
    );

    expect(sent[0]!.input).toEqual({ gatewayIdentifier: "gw-1" });
    expect(sent[1]!.input).toEqual({
      policyEngineId: expectedEngineId,
      resource: { arn: GATEWAY_ARN },
      content: { rawText: "deny everything" },
      name: "gen",
    });
    expect(sent.at(-1)!.input).toEqual({
      policyEngineId: expectedEngineId,
      policyGenerationId: "gen-1",
      nextToken: "page-2",
    });
    expect(steps).toEqual([
      "Resolving gateway gw-1",
      "Starting policy generation gen",
      "Waiting for generation to complete",
      "Reading generated policies",
    ]);
    expect(result).toEqual({
      policyGenerationId: "gen-1",
      policyEngineId: expectedEngineId,
      gatewayArn: GATEWAY_ARN,
      policies: [
        {
          statement: FORBID,
          findings: [{ type: "DENY_ALL", description: "denies every request" }],
        },
        { statement: PERMIT, findings: [] },
      ],
    });
  });

  test.each([
    [
      "the gateway has no engine attached and none is given",
      { ...HAPPY, getGateway: { gatewayArn: GATEWAY_ARN } },
      InputValidationError,
      "pass --policy-engine-id",
    ],
    ["GetGateway returns no ARN", { ...HAPPY, getGateway: {} }, Error, "returned no ARN"],
    ["StartPolicyGeneration returns no id", { ...HAPPY, start: {} }, Error, "no generation id"],
    [
      "the generation fails",
      { ...HAPPY, get: { status: "GENERATE_FAILED", statusReasons: ["bad prompt", "try again"] } },
      Error,
      "failed: bad prompt; try again",
    ],
    [
      "no asset carries a statement",
      {
        ...HAPPY,
        assets: [
          {
            policyGenerationAssets: [
              {
                rawTextFragment: "do the thing",
                findings: [{ type: "INVALID", description: "Non-translatable" }],
              },
            ],
          },
        ],
      },
      Error,
      "could not be translated into a Cedar policy: [INVALID] Non-translatable",
    ],
    [
      "there are no assets",
      { ...HAPPY, assets: [{ policyGenerationAssets: [] }] },
      Error,
      "produced no policy statement",
    ],
  ])("fails when %s", async (_label, responses, errorClass, message) => {
    const run = drain(
      policyClient(responses).generatePolicy(
        { gatewayId: "gw-1", prompt: "x", name: "gen" },
        options,
      ),
    );
    await expect(run).rejects.toBeInstanceOf(errorClass);
    await expect(run).rejects.toThrow(message);
  });

  test("times out when the generation keeps running", async () => {
    const run = drain(
      policyClient({ ...HAPPY, get: { status: "GENERATING" } }).generatePolicy(
        { gatewayId: "gw-1", prompt: "x", name: "gen" },
        options,
      ),
    );
    await expect(run).rejects.toBeInstanceOf(NetworkingError);
    await expect(run).rejects.toThrow("did not finish within 2s");
  }, 10_000);
});
