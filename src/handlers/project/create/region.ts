import { isChinaRegion, supportsRuntimeV2 } from "../../../core/partition";
import {
  BMA_CN_MESSAGE,
  HARNESS_CN_MESSAGE,
  MEMORY_STRIPPED_CN_MESSAGE,
  chinaModelProviderRestriction,
} from "../../../core/project/manager";
import { hasBoxProfile } from "../../../core/project/templates/boxProfile";
import { RegionUnsupportedFeatureError } from "../../../errors";
import type { CreateProjectInput } from "../types";

/** Applies the hard create-time restrictions shared by the CLI and interactive wizard. */
export function validateCreateRegionSupport(input: CreateProjectInput, region: string): void {
  if (!isChinaRegion(region)) return;

  if (input.scaffoldHarnessInput !== undefined) {
    throw new RegionUnsupportedFeatureError(HARNESS_CN_MESSAGE);
  }

  const runtime = input.scaffoldRuntimeInput;
  if (runtime === undefined) return;
  if (runtime.framework === "bma") {
    throw new RegionUnsupportedFeatureError(BMA_CN_MESSAGE);
  }
  const restriction = chinaModelProviderRestriction(runtime);
  if (restriction !== undefined) {
    throw new RegionUnsupportedFeatureError(restriction);
  }
}

/**
 * Drops the defaults a China (aws-cn) region cannot provision — today the
 * template's default memory, since AgentCore Memory is not available there.
 * Shared by the CLI and the interactive wizard, and run only after
 * validateCreateRegionSupport has passed the hard restrictions. Returns the
 * notice to show the user, or undefined when nothing was dropped.
 */
export function stripCreateRegionUnavailableDefaults(
  input: CreateProjectInput,
  region: string,
): string | undefined {
  if (!isChinaRegion(region) || input.scaffoldRuntimeInput?.memory === undefined) return undefined;
  input.scaffoldRuntimeInput.memory = undefined;
  return MEMORY_STRIPPED_CN_MESSAGE;
}

/**
 * The warning create gives for a box template in a region where AgentCore Runtime has no V2, which
 * Box needs. Create still makes the project: the region here is often only the one the CLI
 * resolved, and the project can deploy to a target in another region. Deploy refuses the region.
 * Shared by the CLI and the interactive wizard. Undefined when there is nothing to warn about.
 */
export function boxRegionWarning(input: CreateProjectInput, region: string): string | undefined {
  const runtime = input.scaffoldRuntimeInput;
  if (runtime === undefined || !hasBoxProfile(runtime) || supportsRuntimeV2(region))
    return undefined;
  return (
    `Box runs on AgentCore Runtime V2, which is not available in ${region}, so this project ` +
    "cannot be deployed there. Deploy it with --region set to a region that has V2, or to a " +
    "target in another region."
  );
}
