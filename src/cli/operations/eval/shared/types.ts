/**
 * Shared types for dataset-driven evaluation.
 */

/** A single turn in a predefined scenario. */
export interface Turn {
  input: string;
  expectedResponse?: string;
}

/** A predefined evaluation scenario parsed from JSONL. */
export interface PredefinedScenario {
  scenario_id: string;
  turns: Turn[];
  assertions?: string[];
  expected_trajectory?: string[];
}
