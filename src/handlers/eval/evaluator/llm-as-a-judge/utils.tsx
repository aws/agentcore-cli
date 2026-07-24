import z from "zod";
import type { RatingScale } from "@aws-sdk/client-bedrock-agentcore-control";
import { flag } from "../../../../router";
import { parseJsonFlag } from "../../../utils";
import {
  RATING_SCALE_PRESET_IDS,
  isRatingScalePreset,
  ratingScaleFromPreset,
} from "../../ratingScale";
import type { SourceResolver } from "../../source";

export const LEVELS = ["SESSION", "TRACE", "TOOL_CALL"] as const;

export const instructionsFlag = flag(
  "instructions",
  "evaluation instructions (inline, file://<path>, or - for stdin)",
  z.string().optional(),
);

export const ratingScaleFlag = flag(
  "rating-scale",
  `rating scale: a preset (${RATING_SCALE_PRESET_IDS.join(" | ")}) or a custom RatingScale (JSON inline, file://<path>, or - for stdin)`,
  z.string().optional(),
);

// resolveRatingScale turns the single --rating-scale value into a RatingScale, or
// undefined when the flag is omitted. A value matching a known preset id expands
// to that preset; anything else is a source-aware JSON RatingScale (inline,
// file://<path>, or - for stdin). A file literally named after a preset is still
// reachable via file://.
export async function resolveRatingScale(
  value: string | undefined,
  source: SourceResolver,
): Promise<RatingScale | undefined> {
  if (value === undefined) return undefined;
  if (isRatingScalePreset(value)) return ratingScaleFromPreset(value);
  const raw = await source.resolve("rating-scale", value);
  return parseJsonFlag<RatingScale>("rating-scale", raw);
}
