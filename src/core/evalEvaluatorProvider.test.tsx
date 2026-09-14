import { describe, expect, test } from "bun:test";
import {
  GetEvaluatorCommand,
  UpdateEvaluatorCommand,
  type BedrockAgentCoreControlClient,
  type EvaluatorConfig,
  type UpdateEvaluatorRequest,
} from "@aws-sdk/client-bedrock-agentcore-control";
import type { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import type { IAMClient } from "@aws-sdk/client-iam";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { CoreClient } from "./index";
import { InputValidationError } from "../errors";
import { createSilentLogger } from "../testing";

const OPTIONS = { region: "us-west-2", endpointUrl: undefined };
const ID = "eval-0000000000";
const RATING_SCALE = { categorical: [{ label: "pass", definition: "ok" }] };

// captureUpdate builds a CoreClient whose GetEvaluator returns `existing` and
// whose UpdateEvaluator records the request it receives, so a test can assert
// the merged evaluatorConfig without a live service.
function captureUpdate(existing: EvaluatorConfig): {
  core: CoreClient;
  sent: () => UpdateEvaluatorRequest;
} {
  let captured: UpdateEvaluatorRequest | undefined;
  const control = {
    send: async (command: unknown) => {
      if (command instanceof GetEvaluatorCommand) {
        return { evaluatorId: ID, level: "SESSION", evaluatorConfig: existing };
      }
      if (command instanceof UpdateEvaluatorCommand) {
        captured = command.input;
        return { evaluatorId: ID };
      }
      throw new Error(`unexpected control command: ${(command as object).constructor.name}`);
    },
  } as unknown as BedrockAgentCoreControlClient;

  const core = new CoreClient({
    createControlClient: () => control,
    createDataClient: () => ({}) as BedrockAgentCoreClient,
    createIamClient: () => ({}) as IAMClient,
    createLogsClient: () => ({}) as CloudWatchLogsClient,
    logger: createSilentLogger(),
  });
  return {
    core,
    sent: () => {
      if (!captured) throw new Error("UpdateEvaluator was never called");
      return captured;
    },
  };
}

const bedrockExisting = (extra: Record<string, unknown> = {}): EvaluatorConfig => ({
  llmAsAJudge: {
    instructions: "Judge from {context}.",
    ratingScale: RATING_SCALE,
    modelConfig: {
      bedrockEvaluatorModelConfig: { modelId: "bedrock.model-v1:0", ...extra },
    },
  },
});

const responsesExisting = (extra: Record<string, unknown> = {}): EvaluatorConfig => ({
  llmAsAJudge: {
    instructions: "Judge from {context}.",
    ratingScale: RATING_SCALE,
    modelConfig: {
      responsesEvaluatorModelConfig: {
        modelId: "openai.gpt-5.4",
        maxOutputTokens: 4096,
        temperature: 0,
        ...extra,
      },
    },
  },
});

function llaj(request: UpdateEvaluatorRequest) {
  const config = request.evaluatorConfig;
  if (!config || !("llmAsAJudge" in config) || !config.llmAsAJudge) {
    throw new Error("expected an llmAsAJudge config on the update request");
  }
  return config.llmAsAJudge;
}

describe("updateLlmAsAJudgeEvaluator provider handling", () => {
  test("a Bedrock model-only update preserves inferenceConfig and extra fields", async () => {
    const { core, sent } = captureUpdate(
      bedrockExisting({
        inferenceConfig: { temperature: 0, maxTokens: 512 },
        additionalModelRequestFields: { anthropic_version: "x" },
      }),
    );
    await core.eval.updateLlmAsAJudgeEvaluator(ID, { model: "bedrock.model-v2:0" }, OPTIONS);

    const model = llaj(sent()).modelConfig?.bedrockEvaluatorModelConfig;
    expect(model?.modelId).toBe("bedrock.model-v2:0");
    expect(model?.inferenceConfig).toEqual({ temperature: 0, maxTokens: 512 });
    expect(model?.additionalModelRequestFields).toEqual({ anthropic_version: "x" });
  });

  test("an instructions-only update on OpenResponses stays on the responses arm", async () => {
    const { core, sent } = captureUpdate(
      responsesExisting({ topP: 0.9, reasoning: { effort: "high" } }),
    );
    await core.eval.updateLlmAsAJudgeEvaluator(ID, { instructions: "New {context}." }, OPTIONS);

    const config = llaj(sent()).modelConfig!;
    expect("responsesEvaluatorModelConfig" in config).toBe(true);
    const model = config.responsesEvaluatorModelConfig!;
    expect(model.modelId).toBe("openai.gpt-5.4");
    expect(model.maxOutputTokens).toBe(4096);
    expect(model.temperature).toBe(0);
    expect(model.topP).toBe(0.9);
    expect(model.reasoning).toEqual({ effort: "high" });
    expect(llaj(sent()).instructions).toBe("New {context}.");
  });

  test("changing provider without a new model is rejected before the SDK call", async () => {
    const { core } = captureUpdate(bedrockExisting());
    await expect(
      core.eval.updateLlmAsAJudgeEvaluator(ID, { modelProvider: "OpenResponses" }, OPTIONS),
    ).rejects.toBeInstanceOf(InputValidationError);
  });

  test("changing provider with a new model selects the correct arm and defaults", async () => {
    const { core, sent } = captureUpdate(bedrockExisting({ inferenceConfig: { temperature: 0 } }));
    await core.eval.updateLlmAsAJudgeEvaluator(
      ID,
      { modelProvider: "OpenResponses", model: "openai.gpt-5.4" },
      OPTIONS,
    );

    const config = llaj(sent()).modelConfig!;
    expect("responsesEvaluatorModelConfig" in config).toBe(true);
    // The Bedrock inferenceConfig must not leak into the new arm.
    expect("bedrockEvaluatorModelConfig" in config).toBe(false);
    expect(config.responsesEvaluatorModelConfig).toEqual({
      modelId: "openai.gpt-5.4",
      maxOutputTokens: 4096,
      temperature: 0,
    });
  });
});
