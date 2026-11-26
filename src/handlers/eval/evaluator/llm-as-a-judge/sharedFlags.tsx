import z from "zod";
import type { EvaluatorModelConfig, RatingScale } from "@aws-sdk/client-bedrock-agentcore-control";
import { flag } from "../../../../router";
import { parseJsonObjectFlag } from "../../../utils";
import {
  RATING_SCALE_PRESET_IDS,
  isRatingScalePreset,
  ratingScaleFromPreset,
} from "../../ratingScale";
import {
  EvaluatorModelProviderSchema,
  type EvaluatorModelProvider,
} from "../../../../projectSchemas/evaluator";
import type { SourceResolver } from "../../../../io";
import {
  withBedrockInference,
  withOpenResponsesInference,
} from "../../../../core/eval/judgeInference";
import type { EvaluatorInferenceSettings } from "../../types";

// The token budget and temperature the old CLI's project deployment applies to
// an OpenResponses judge. topP is deliberately omitted so behavior matches it.
const OPEN_RESPONSES_DEFAULTS = { maxOutputTokens: 4096, temperature: 0 } as const;

// The enum schema validates the value at parse time (the router rejects anything
// other than Bedrock/OpenResponses), so no handler-side check is needed. Optional,
// not defaulted: create treats an omitted provider as Bedrock, while update treats
// it as "keep the evaluator's current provider".
export const modelProviderFlag = flag(
  "model-provider",
  "model provider for the judge: Bedrock (default) or OpenResponses",
  EvaluatorModelProviderSchema.optional(),
);

// Judge tuning shared by create and update. Each flag is optional with no
// default: an omitted one leaves the evaluator's current value (or the provider
// default) untouched. --temperature admits the wider OpenResponses range; the
// Bedrock 0-1 bound is checked once the provider is resolved.
export const inferenceFlags = [
  flag(
    "max-tokens",
    "maximum tokens the judge model may generate (min 1)",
    z.number().int().min(1).optional(),
  ),
  flag(
    "temperature",
    "judge sampling temperature: 0-1 for Bedrock, 0-2 for OpenResponses",
    z.number().min(0).max(2).optional(),
  ),
  flag("top-p", "judge top-p (nucleus) sampling value (0-1)", z.number().min(0).max(1).optional()),
] as const;

// inferenceFromFlags collects the inference flags, or undefined when none was
// passed, so the request carries no tuning the caller did not ask for.
export function inferenceFromFlags(flags: {
  "max-tokens"?: number;
  temperature?: number;
  "top-p"?: number;
}): EvaluatorInferenceSettings | undefined {
  const inference: EvaluatorInferenceSettings = {
    maxTokens: flags["max-tokens"],
    temperature: flags["temperature"],
    topP: flags["top-p"],
  };
  return Object.values(inference).some((value) => value !== undefined) ? inference : undefined;
}

// buildEvaluatorModelConfig selects the SDK modelConfig union arm for the
// resolved provider. OpenResponses carries the deployment token/temperature
// defaults; Bedrock passes the model id alone (the service supplies its own).
// Any inference settings are applied on top of those.
export function buildEvaluatorModelConfig(
  provider: EvaluatorModelProvider,
  modelId: string,
  inference?: EvaluatorInferenceSettings,
): EvaluatorModelConfig {
  if (provider === "OpenResponses") {
    return {
      responsesEvaluatorModelConfig: withOpenResponsesInference(
        { modelId, ...OPEN_RESPONSES_DEFAULTS },
        inference,
      ),
    };
  }
  return { bedrockEvaluatorModelConfig: withBedrockInference({ modelId }, inference) };
}

const ratingScaleDescription = `rating scale: a preset (${RATING_SCALE_PRESET_IDS.join(" | ")}) or a custom RatingScale (JSON inline, file://<path>, or - for stdin)`;

export const ratingScaleFlag = {
  ...flag("rating-scale", ratingScaleDescription, z.string().min(1)),
  optional: () => flag("rating-scale", ratingScaleDescription, z.string().optional()),
};

// resolveRatingScale turns the single --rating-scale value into a RatingScale, or
// undefined when the flag is omitted. A value matching a known preset id expands
// to that preset; anything else is a source-aware JSON RatingScale (inline,
// file://<path>, or - for stdin). A file literally named after a preset is still
// reachable via file://.
export function resolveRatingScale(value: string, source: SourceResolver): Promise<RatingScale>;
export function resolveRatingScale(
  value: string | undefined,
  source: SourceResolver,
): Promise<RatingScale | undefined>;
export async function resolveRatingScale(
  value: string | undefined,
  source: SourceResolver,
): Promise<RatingScale | undefined> {
  if (value === undefined) return undefined;
  if (isRatingScalePreset(value)) return ratingScaleFromPreset(value);
  const raw = await source.resolveText("rating-scale", value);
  return parseJsonObjectFlag<RatingScale>("rating-scale", raw);
}
