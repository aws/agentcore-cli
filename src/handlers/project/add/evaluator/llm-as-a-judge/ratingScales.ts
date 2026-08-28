import type { RatingScale } from "../../../../../projectSchemas/evaluator";

/**
 * Named rating-scale presets for `add evaluator llm-as-a-judge --rating-scale`.
 *
 * Each preset expands into the {@link RatingScale} shape the schema expects:
 * numerical scales carry an integer `value` per rung, categorical scales do not.
 * The `definition` text is surfaced to the judge model, so it must describe the
 * rung precisely enough for the model to choose between adjacent options.
 */
export const RATING_SCALE_PRESETS = {
  "1-5-quality": {
    numerical: [
      {
        value: 1,
        label: "Very Poor",
        definition: "The response fails to address the task and contains significant errors.",
      },
      {
        value: 2,
        label: "Poor",
        definition:
          "The response partially addresses the task but has notable gaps or inaccuracies.",
      },
      {
        value: 3,
        label: "Fair",
        definition: "The response addresses the task adequately, with minor issues.",
      },
      {
        value: 4,
        label: "Good",
        definition: "The response addresses the task well and is accurate and helpful.",
      },
      {
        value: 5,
        label: "Excellent",
        definition: "The response fully addresses the task and is accurate, complete, and helpful.",
      },
    ],
  },
  "1-3-simple": {
    numerical: [
      {
        value: 1,
        label: "Poor",
        definition: "The response does not meet expectations.",
      },
      {
        value: 2,
        label: "Acceptable",
        definition: "The response meets basic expectations, with some shortcomings.",
      },
      {
        value: 3,
        label: "Good",
        definition: "The response fully meets expectations.",
      },
    ],
  },
  "pass-fail": {
    categorical: [
      { label: "pass", definition: "The response meets the evaluation criteria." },
      { label: "fail", definition: "The response does not meet the evaluation criteria." },
    ],
  },
  "good-neutral-bad": {
    categorical: [
      { label: "good", definition: "The response is helpful and meets the evaluation criteria." },
      { label: "neutral", definition: "The response is neither clearly good nor clearly bad." },
      {
        label: "bad",
        definition: "The response is unhelpful or violates the evaluation criteria.",
      },
    ],
  },
} as const satisfies Record<string, RatingScale>;

export type RatingScalePreset = keyof typeof RATING_SCALE_PRESETS;

export const RATING_SCALE_PRESET_NAMES = Object.keys(RATING_SCALE_PRESETS) as RatingScalePreset[];

export function isRatingScalePreset(value: string): value is RatingScalePreset {
  return value in RATING_SCALE_PRESETS;
}
