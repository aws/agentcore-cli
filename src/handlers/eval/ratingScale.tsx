import type { RatingScale } from "@aws-sdk/client-bedrock-agentcore-control";

// Rating-scale presets. `--rating-scale <preset>` expands to a full RatingScale
// union for the common cases; `--rating-scale-json` accepts a raw RatingScale for
// anything the presets don't cover (mirrors what the API supports directly).
export const RATING_SCALE_PRESET_IDS = [
  "1-5-quality",
  "1-3-simple",
  "pass-fail",
  "good-neutral-bad",
] as const;

export type RatingScalePresetId = (typeof RATING_SCALE_PRESET_IDS)[number];

const PRESETS: Record<RatingScalePresetId, RatingScale> = {
  "1-5-quality": {
    numerical: [
      { value: 1, label: "Poor", definition: "Fails to meet expectations" },
      { value: 2, label: "Fair", definition: "Partially meets expectations" },
      { value: 3, label: "Good", definition: "Meets expectations" },
      { value: 4, label: "Very Good", definition: "Exceeds expectations" },
      { value: 5, label: "Excellent", definition: "Far exceeds expectations" },
    ],
  },
  "1-3-simple": {
    numerical: [
      { value: 1, label: "Low", definition: "Below acceptable quality" },
      { value: 2, label: "Medium", definition: "Acceptable quality" },
      { value: 3, label: "High", definition: "Above acceptable quality" },
    ],
  },
  "pass-fail": {
    categorical: [
      { label: "Pass", definition: "Meets the evaluation criteria" },
      { label: "Fail", definition: "Does not meet the evaluation criteria" },
    ],
  },
  "good-neutral-bad": {
    categorical: [
      { label: "Good", definition: "Positive outcome, meets or exceeds criteria" },
      { label: "Neutral", definition: "Acceptable but unremarkable outcome" },
      { label: "Bad", definition: "Negative outcome, fails to meet criteria" },
    ],
  },
};

// ratingScaleFromPreset returns the RatingScale for a preset id.
export function ratingScaleFromPreset(id: RatingScalePresetId): RatingScale {
  return PRESETS[id];
}
