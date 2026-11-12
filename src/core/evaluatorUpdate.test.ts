import { describe, expect, test } from "bun:test";
import {
  GetEvaluatorCommand,
  UpdateEvaluatorCommand,
  type BedrockAgentCoreControlClient,
  type EvaluatorModelConfig,
  type UpdateEvaluatorCommandInput,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../errors";
import { expectError } from "../testing";
import { EvalClient } from "./eval";
import type { AwsClients } from "./types";

const OPTIONS = { region: "us-west-2" };
const EVALUATOR_ID = "judge-0000000000";
const BEDROCK_MODEL = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const INSTRUCTIONS = "Judge from {context} whether the agent resolved the request.";
const RATING_SCALE = { numerical: [{ value: 1, label: "Poor", definition: "d" }] };

// subject stubs the control client: GetEvaluator returns an LLM-as-a-Judge
// evaluator with the given modelConfig, and every command sent is recorded so
// the test can assert the UpdateEvaluator input the merge produced.
function subject(modelConfig: EvaluatorModelConfig): { client: EvalClient; sent: unknown[] } {
  const sent: unknown[] = [];
  const control = {
    send: async (command: unknown) => {
      sent.push(command);
      if (command instanceof GetEvaluatorCommand) {
        return {
          evaluatorId: EVALUATOR_ID,
          evaluatorConfig: {
            llmAsAJudge: { instructions: INSTRUCTIONS, ratingScale: RATING_SCALE, modelConfig },
          },
        };
      }
      return { evaluatorId: EVALUATOR_ID };
    },
  } as unknown as BedrockAgentCoreControlClient;
  const clients = { control: () => control } as unknown as AwsClients;
  return { client: new EvalClient(clients), sent };
}

function sentModelConfig(sent: unknown[]): EvaluatorModelConfig | undefined {
  const update = sent.find((command) => command instanceof UpdateEvaluatorCommand) as
    UpdateEvaluatorCommand | undefined;
  const input: UpdateEvaluatorCommandInput | undefined = update?.input;
  const config = input?.evaluatorConfig;
  return config && "llmAsAJudge" in config ? config.llmAsAJudge?.modelConfig : undefined;
}

describe("EvalClient.updateLlmAsAJudgeEvaluator inference settings", () => {
  test("overlays the passed fields on the Bedrock inferenceConfig and keeps the rest", async () => {
    const { client, sent } = subject({
      bedrockEvaluatorModelConfig: {
        modelId: BEDROCK_MODEL,
        inferenceConfig: { temperature: 0, maxTokens: 512, stopSequences: ["</score>"] },
        additionalModelRequestFields: { top_k: 50 },
      },
    });

    await client.updateLlmAsAJudgeEvaluator(
      EVALUATOR_ID,
      { inference: { maxTokens: 2048 } },
      OPTIONS,
    );

    expect(sentModelConfig(sent)).toEqual({
      bedrockEvaluatorModelConfig: {
        modelId: BEDROCK_MODEL,
        inferenceConfig: { temperature: 0, maxTokens: 2048, stopSequences: ["</score>"] },
        additionalModelRequestFields: { top_k: 50 },
      },
    });
  });

  test("adds an inferenceConfig to a Bedrock judge that had none", async () => {
    const { client, sent } = subject({ bedrockEvaluatorModelConfig: { modelId: BEDROCK_MODEL } });

    await client.updateLlmAsAJudgeEvaluator(
      EVALUATOR_ID,
      { inference: { temperature: 0.2, topP: 0.9 } },
      OPTIONS,
    );

    expect(sentModelConfig(sent)).toEqual({
      bedrockEvaluatorModelConfig: {
        modelId: BEDROCK_MODEL,
        inferenceConfig: { temperature: 0.2, topP: 0.9 },
      },
    });
  });

  test("maps --max-tokens to maxOutputTokens on an OpenResponses judge", async () => {
    const { client, sent } = subject({
      responsesEvaluatorModelConfig: {
        modelId: "openai.gpt-5.4",
        maxOutputTokens: 4096,
        temperature: 0,
        reasoning: { effort: "low" },
      },
    });

    await client.updateLlmAsAJudgeEvaluator(
      EVALUATOR_ID,
      { inference: { maxTokens: 8192, temperature: 1.5 } },
      OPTIONS,
    );

    expect(sentModelConfig(sent)).toEqual({
      responsesEvaluatorModelConfig: {
        modelId: "openai.gpt-5.4",
        maxOutputTokens: 8192,
        temperature: 1.5,
        reasoning: { effort: "low" },
      },
    });
  });

  test("applies the settings over the OpenResponses defaults on a provider switch", async () => {
    const { client, sent } = subject({
      bedrockEvaluatorModelConfig: {
        modelId: BEDROCK_MODEL,
        inferenceConfig: { maxTokens: 512 },
      },
    });

    await client.updateLlmAsAJudgeEvaluator(
      EVALUATOR_ID,
      { modelProvider: "OpenResponses", model: "openai.gpt-5.4", inference: { topP: 0.5 } },
      OPTIONS,
    );

    expect(sentModelConfig(sent)).toEqual({
      responsesEvaluatorModelConfig: {
        modelId: "openai.gpt-5.4",
        maxOutputTokens: 4096,
        temperature: 0,
        topP: 0.5,
      },
    });
  });

  // The flag schema admits up to 2 for OpenResponses, so the Bedrock bound can
  // only be checked once the evaluator's current provider is known.
  test("rejects a temperature above 1 for a Bedrock judge without sending the update", async () => {
    const { client, sent } = subject({ bedrockEvaluatorModelConfig: { modelId: BEDROCK_MODEL } });

    await expectError(
      client.updateLlmAsAJudgeEvaluator(EVALUATOR_ID, { inference: { temperature: 1.5 } }, OPTIONS),
      /invalid --temperature 1.5: the Bedrock judge accepts 0-1/,
      InputValidationError,
    );
    expect(sent.some((command) => command instanceof UpdateEvaluatorCommand)).toBe(false);
  });
});
