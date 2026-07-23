import { test, expect } from "bun:test";
import {
  GetEvaluatorCommand,
  UpdateEvaluatorCommand,
  type GetEvaluatorResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { EvalClient } from "./eval";
import type { AwsClients, CoreOptions } from "./types";

const OPTIONS: CoreOptions = { region: "us-west-2", endpointUrl: undefined };

// fakeClients returns an AwsClients whose control().send dispatches GetEvaluator
// to `getResponse` and records UpdateEvaluator inputs into `updates`. Only
// control() is used by EvalClient; data()/iam() throw if ever reached.
function fakeClients(getResponse: GetEvaluatorResponse, updates: unknown[]): AwsClients {
  const control = {
    send: async (command: { input: unknown }) => {
      if (command instanceof GetEvaluatorCommand) return getResponse;
      if (command instanceof UpdateEvaluatorCommand) {
        updates.push(command.input);
        return { evaluatorId: "e-1" };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
  return {
    control: () => control as never,
    data: () => {
      throw new Error("data client not expected");
    },
    iam: () => {
      throw new Error("iam client not expected");
    },
  };
}

test("updateLlmAsAJudgeEvaluator preserves existing fields not passed", async () => {
  const updates: unknown[] = [];
  const current: GetEvaluatorResponse = {
    evaluatorConfig: {
      llmAsAJudge: {
        instructions: "old instructions",
        ratingScale: { numerical: [{ value: 1, label: "L", definition: "d" }] },
        modelConfig: { bedrockEvaluatorModelConfig: { modelId: "old-model" } },
      },
    },
  } as GetEvaluatorResponse;

  const client = new EvalClient(fakeClients(current, updates));
  // Only the model changes; instructions + ratingScale should be carried over.
  await client.updateLlmAsAJudgeEvaluator("e-1", { model: "new-model" }, OPTIONS);

  expect(updates).toHaveLength(1);
  const sent = updates[0] as any;
  expect(sent.evaluatorConfig.llmAsAJudge.modelConfig.bedrockEvaluatorModelConfig.modelId).toBe(
    "new-model",
  );
  expect(sent.evaluatorConfig.llmAsAJudge.instructions).toBe("old instructions");
  expect(sent.evaluatorConfig.llmAsAJudge.ratingScale.numerical[0].label).toBe("L");
});

test("updateLlmAsAJudgeEvaluator rejects a non-LLM evaluator", async () => {
  const current: GetEvaluatorResponse = {
    evaluatorConfig: { codeBased: { lambdaConfig: { lambdaArn: "arn:x" } } },
  } as GetEvaluatorResponse;
  const client = new EvalClient(fakeClients(current, []));
  await expect(
    client.updateLlmAsAJudgeEvaluator("e-1", { instructions: "x" }, OPTIONS),
  ).rejects.toThrow(/not an LLM-as-a-Judge evaluator/);
});

test("updateCodeBasedEvaluator preserves the lambda ARN when only timeout changes", async () => {
  const updates: unknown[] = [];
  const current: GetEvaluatorResponse = {
    evaluatorConfig: {
      codeBased: { lambdaConfig: { lambdaArn: "arn:keep", lambdaTimeoutInSeconds: 10 } },
    },
  } as GetEvaluatorResponse;

  const client = new EvalClient(fakeClients(current, updates));
  await client.updateCodeBasedEvaluator("e-1", { timeout: 45 }, OPTIONS);

  const sent = updates[0] as any;
  expect(sent.evaluatorConfig.codeBased.lambdaConfig.lambdaArn).toBe("arn:keep");
  expect(sent.evaluatorConfig.codeBased.lambdaConfig.lambdaTimeoutInSeconds).toBe(45);
});

test("updateCodeBasedEvaluator rejects a non-code-based evaluator", async () => {
  const current = {
    evaluatorConfig: {
      llmAsAJudge: {
        instructions: "i",
        ratingScale: { numerical: [] },
        modelConfig: { bedrockEvaluatorModelConfig: { modelId: "m" } },
      },
    },
  } as unknown as GetEvaluatorResponse;
  const client = new EvalClient(fakeClients(current, []));
  await expect(client.updateCodeBasedEvaluator("e-1", { timeout: 30 }, OPTIONS)).rejects.toThrow(
    /not a code-based evaluator/,
  );
});
