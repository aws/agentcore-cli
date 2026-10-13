import type { V0ProjectSpec } from "../../../projectSchemas/v0";

/** The v0 collections that have no place in v1's spec, kept aside by the translator. */
export type LegacyExtras = Pick<
  V0ProjectSpec,
  "abTests" | "datasets" | "capacityProviders" | "unassignedTargets"
>;

export type LegacyProjectInfo = {
  format: "v0";
  /** The v0 spec as parsed by the v0 schema; the source of truth for v0-only reads. */
  v0Spec: V0ProjectSpec;
  extras: LegacyExtras;
};
