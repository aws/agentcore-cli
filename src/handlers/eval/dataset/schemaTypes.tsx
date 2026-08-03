import type { DatasetSchemaType } from "@aws-sdk/client-bedrock-agentcore-control";

export const SCHEMA_TYPE_ALIASES = ["predefined", "simulated"] as const;

export type SchemaTypeAlias = (typeof SCHEMA_TYPE_ALIASES)[number];

// predefined datasets carry pre-written inputs per conversation turn; simulated
// datasets carry scenarios used to generate full conversations synthetically.
const SCHEMA_TYPES: Record<SchemaTypeAlias, DatasetSchemaType> = {
  predefined: "AGENTCORE_EVALUATION_PREDEFINED_V1",
  simulated: "AGENTCORE_EVALUATION_SIMULATED_V1",
};

// datasetSchemaType maps a `--schema-type` alias to the API enum value.
export function datasetSchemaType(alias: SchemaTypeAlias): DatasetSchemaType {
  return SCHEMA_TYPES[alias];
}
