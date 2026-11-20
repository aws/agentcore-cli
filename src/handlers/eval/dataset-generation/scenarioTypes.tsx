import type { ScenarioType } from "@aws-sdk/client-bedrock-agentcore";

export const SCENARIO_TYPE_ALIASES = ["fixed", "dynamic"] as const;

export type ScenarioTypeAlias = (typeof SCENARIO_TYPE_ALIASES)[number];

const SCENARIO_TYPES: Record<ScenarioTypeAlias, ScenarioType> = {
  fixed: "FIXED",
  dynamic: "DYNAMIC",
};

export function scenarioType(alias: ScenarioTypeAlias): ScenarioType {
  return SCENARIO_TYPES[alias];
}
