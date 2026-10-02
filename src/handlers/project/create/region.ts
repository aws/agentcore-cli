import { isChinaRegion } from "../../../core/partition";
import {
  BMA_CN_MESSAGE,
  HARNESS_CN_MESSAGE,
  LITELLM_BEDROCK_MODEL_ID_CN_MESSAGE,
  LITELLM_MODEL_ID_REQUIRED_CN_MESSAGE,
  MEMORY_STRIPPED_CN_MESSAGE,
  MODEL_PROVIDER_RUNTIMES_CN_MESSAGE,
} from "../../../core/project/manager";
import { RegionUnsupportedFeatureError } from "../../../errors";
import type { CreateProjectInput } from "../types";

/** Applies the hard create-time restrictions shared by the CLI and interactive wizard. */
export function validateCreateRegionSupport(input: CreateProjectInput, region: string): void {
  if (!isChinaRegion(region)) return;

  if (input.scaffoldHarnessInput !== undefined) {
    throw new RegionUnsupportedFeatureError(HARNESS_CN_MESSAGE);
  }

  const runtime = input.scaffoldRuntimeInput;
  if (runtime === undefined || runtime.framework === "none") return;
  if (runtime.framework === "bma") {
    throw new RegionUnsupportedFeatureError(BMA_CN_MESSAGE);
  }
  if ((runtime.modelProvider ?? "Bedrock") !== "LiteLLM") {
    throw new RegionUnsupportedFeatureError(MODEL_PROVIDER_RUNTIMES_CN_MESSAGE);
  }
  if (runtime.modelId === undefined) {
    throw new RegionUnsupportedFeatureError(LITELLM_MODEL_ID_REQUIRED_CN_MESSAGE);
  }
  if (runtime.modelId.startsWith("bedrock/")) {
    throw new RegionUnsupportedFeatureError(LITELLM_BEDROCK_MODEL_ID_CN_MESSAGE);
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
