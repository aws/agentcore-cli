import { BOX_TEMPLATE_TAG_VALUE } from "../../projectSchemas/project";
import { TEMPLATE_TAG_KEY } from "../../projectSchemas/tags";
import { BMA_TEMPLATE_PROFILE } from "./bma";
import type { RuntimeTemplateProfile } from "./templateProfile";
import type { ScaffoldRuntimeInput } from "./types";

/**
 * Resolve the effective profile from stable scaffold fields.
 *
 * BMA's runtime contract is intrinsic to its framework, so reconstructed
 * inputs cannot lose or override it by omitting or changing internal metadata.
 * Likewise every box runtime (`boxTemplate`) gets the `agentcore:template`
 * tag, so it cannot ship untagged: the template name that
 * `resolveRuntimeTemplateShortcut` puts in the profile, or `strands-box` when
 * the profile has none, as for a runtime `add runtime` adds to a Box project.
 * The tag goes after the profile's other tags, so none of them replaces it.
 */
export function resolveRuntimeTemplateProfile(
  input: Pick<ScaffoldRuntimeInput, "framework" | "templateProfile" | "boxTemplate">,
): RuntimeTemplateProfile | undefined {
  if (input.framework === "bma") {
    return BMA_TEMPLATE_PROFILE;
  }
  if (input.boxTemplate) {
    const profile = input.templateProfile;
    const template = profile?.runtime?.tags?.[TEMPLATE_TAG_KEY] ?? BOX_TEMPLATE_TAG_VALUE;
    return {
      ...profile,
      runtime: {
        ...profile?.runtime,
        tags: { ...profile?.runtime?.tags, [TEMPLATE_TAG_KEY]: template },
      },
    };
  }
  return input.templateProfile;
}
