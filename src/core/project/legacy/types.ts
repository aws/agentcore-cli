import type { V0ProjectSpec } from "../../../projectSchemas/v0";

export type LegacyProjectInfo = {
  format: "v0";
  /** The v0 spec as parsed by the v0 schema; the source of truth for v0-only reads. */
  v0Spec: V0ProjectSpec;
};
