import { BMA_TEMPLATE_NAME, BMA_TEMPLATE_PROFILE } from "./bmaProfile";
import type { RuntimeTemplateProfile } from "./templateProfile";
import type { ScaffoldRuntimeInput } from "./types";

/**
 * Resolve the effective profile from stable scaffold fields.
 *
 * BMA's runtime contract is intrinsic to its framework, so reconstructed
 * inputs cannot lose or override it by omitting or changing internal metadata.
 */
export function resolveRuntimeTemplateProfile(
  input: Pick<ScaffoldRuntimeInput, "framework" | "templateProfile">,
): RuntimeTemplateProfile | undefined {
  if (input.framework === BMA_TEMPLATE_NAME) {
    return BMA_TEMPLATE_PROFILE;
  }
  return input.templateProfile;
}
