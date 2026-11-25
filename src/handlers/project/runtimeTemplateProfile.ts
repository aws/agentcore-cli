import { withBoxTemplateTags } from "../../projectSchemas/project";
import { BMA_TEMPLATE_PROFILE } from "./bma";
import type { RuntimeTemplateProfile } from "./templateProfile";
import type { ScaffoldRuntimeInput } from "./types";

/**
 * Resolve the effective profile from stable scaffold fields.
 *
 * BMA's runtime contract is intrinsic to its framework, so reconstructed
 * inputs cannot lose or override it by omitting or changing internal metadata.
 * Likewise every Box template (`boxTemplate`) tags its runtime with
 * `BOX_TEMPLATE_TAGS`, so a Box template in the shortcut table cannot ship
 * without them. Tags already in the profile win key by key.
 */
export function resolveRuntimeTemplateProfile(
  input: Pick<ScaffoldRuntimeInput, "framework" | "templateProfile" | "boxTemplate">,
): RuntimeTemplateProfile | undefined {
  if (input.framework === "bma") {
    return BMA_TEMPLATE_PROFILE;
  }
  if (input.boxTemplate) {
    const profile = input.templateProfile;
    return {
      ...profile,
      runtime: { ...profile?.runtime, tags: withBoxTemplateTags(profile?.runtime?.tags) },
    };
  }
  return input.templateProfile;
}
