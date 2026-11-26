import type {
  BedrockEvaluatorModelConfig,
  OpenResponsesEvaluatorModelConfig,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../../errors";
import type { EvaluatorInferenceSettings } from "../../handlers/eval/types";
import type { EvaluatorModelProvider } from "../../projectSchemas/evaluator";

// The judge temperature ceiling differs by provider API: Bedrock's
// InferenceConfiguration accepts 0-1, OpenResponsesEvaluatorModelConfig 0-2.
// The --temperature flag schema admits the wider range, so the provider bound
// is enforced here once the provider is known.
export const MAX_JUDGE_TEMPERATURE: Record<EvaluatorModelProvider, number> = {
  Bedrock: 1,
  OpenResponses: 2,
};

export function assertJudgeTemperature(
  provider: EvaluatorModelProvider,
  temperature: number | undefined,
  meta?: Record<string, unknown>,
): void {
  if (temperature === undefined) return;
  const max = MAX_JUDGE_TEMPERATURE[provider];
  if (temperature > max) {
    throw new InputValidationError(
      `invalid --temperature ${temperature}: the ${provider} judge accepts 0-${max}`,
      { meta },
    );
  }
}

// withBedrockInference overlays the set fields onto inferenceConfig, keeping any
// field the caller did not pass (stopSequences included). With nothing set the
// config is returned as is, so the request stays byte-identical to one sent
// without the flags.
export function withBedrockInference(
  config: BedrockEvaluatorModelConfig,
  inference: EvaluatorInferenceSettings | undefined,
): BedrockEvaluatorModelConfig {
  const overrides = definedFields({
    maxTokens: inference?.maxTokens,
    temperature: inference?.temperature,
    topP: inference?.topP,
  });
  if (Object.keys(overrides).length === 0) return config;
  return { ...config, inferenceConfig: { ...config.inferenceConfig, ...overrides } };
}

// withOpenResponsesInference overlays the set fields onto the OpenResponses arm,
// where the token limit is named maxOutputTokens.
export function withOpenResponsesInference(
  config: OpenResponsesEvaluatorModelConfig,
  inference: EvaluatorInferenceSettings | undefined,
): OpenResponsesEvaluatorModelConfig {
  return {
    ...config,
    ...definedFields({
      maxOutputTokens: inference?.maxTokens,
      temperature: inference?.temperature,
      topP: inference?.topP,
    }),
  };
}

// definedFields drops undefined values, so spreading the result never clears a
// field the evaluator already has.
function definedFields<T extends Record<string, number | undefined>>(
  fields: T,
): Partial<Record<keyof T, number>> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<Record<keyof T, number>>;
}
