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

// buildEvaluatorModelConfig selects the SDK modelConfig union arm for the
// resolved provider. OpenResponses carries the deployment token/temperature
// defaults; Bedrock passes the model id alone (the service supplies its own).
export function buildEvaluatorModelConfig(
  provider: EvaluatorModelProvider,
  modelId: string,
): EvaluatorModelConfig {
  if (provider === "OpenResponses") {
    return { responsesEvaluatorModelConfig: { modelId, ...OPEN_RESPONSES_DEFAULTS } };
  }
  return { bedrockEvaluatorModelConfig: { modelId } };
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
