/**
 * Syncs local agentcore.json after the server applies a recommendation to a
 * config bundle.
 *
 * When a recommendation uses a config bundle as input, the server automatically
 * creates a new bundle version with the recommended changes applied. The
 * recommendation result includes the new version's bundleArn and versionId.
 *
 * This module fetches that new version via GetConfigurationBundleVersion and
 * updates the local agentcore.json components to match the server state.
 */
import { ConfigIO, ResourceNotFoundError } from '../../../lib';
import type { Result } from '../../../lib/result';
import { getConfigurationBundleVersion } from '../../aws/agentcore-config-bundles';
import type { RecommendationResult } from '../../aws/agentcore-recommendation';

export interface ApplyRecommendationOptions {
  /** Config bundle name in agentcore.json (used by CLI) */
  bundleName?: string;
  /** Config bundle ARN (used by TUI — resolved to name via deployed state) */
  bundleArn?: string;
  /** The recommendation result from the API (contains new bundle version info) */
  result: RecommendationResult;
  /** AWS region for fetching the new bundle version */
  region: string;
}

export type ApplyRecommendationResult = Result<{ newVersionId?: string }>;

/**
 * Extract the bundleId from a bundle ARN.
 * ARN format: arn:aws:bedrock-agentcore:{region}:{account}:configuration-bundle/{bundleId}
 */
function extractBundleIdFromArn(arn: string): string | undefined {
  const match = /configuration-bundle\/(.+)$/.exec(arn);
  return match?.[1];
}

/**
 * Sync local agentcore.json after the server creates a new config bundle version
 * from a recommendation. Fetches the new version and updates local components.
 */
export async function applyRecommendationToBundle(
  options: ApplyRecommendationOptions,
  configIO: ConfigIO = new ConfigIO()
): Promise<ApplyRecommendationResult> {
  const { result, region } = options;

  // Extract the new bundle version from the recommendation result
  const resultBundle =
    result.systemPromptRecommendationResult?.configurationBundle ??
    result.toolDescriptionRecommendationResult?.configurationBundle;

  if (!resultBundle) {
    return {
      success: false,
      error: new Error(
        'Recommendation result does not contain a new config bundle version. The server may not have applied the recommendation to the bundle.'
      ),
    };
  }

  const bundleId = extractBundleIdFromArn(resultBundle.bundleArn);
  if (!bundleId) {
    return {
      success: false,
      error: new Error(`Could not extract bundle ID from ARN: ${resultBundle.bundleArn}`),
    };
  }

  // Fetch the new version from the server
  const newVersion = await getConfigurationBundleVersion({
    region,
    bundleId,
    versionId: resultBundle.versionId,
  });

  // Read current project spec and deployed state
  const [spec, deployedState] = await Promise.all([configIO.readProjectSpec(), configIO.readDeployedState()]);

  // Find the target bundle by name or by matching ARN in deployed state
  let bundleName: string | undefined;
  if (options.bundleName) {
    bundleName = options.bundleName;
  } else if (options.bundleArn) {
    // TUI stores the ARN — resolve to bundle name via deployed state
    for (const targetName of Object.keys(deployedState.targets ?? {})) {
      const target = deployedState.targets?.[targetName];
      const bundles = target?.resources?.configBundles;
      if (bundles) {
        for (const [name, state] of Object.entries(bundles)) {
          if (state.bundleArn === options.bundleArn) {
            bundleName = name;
            break;
          }
        }
      }
      if (bundleName) break;
    }
  }

  const identifier = bundleName ?? options.bundleArn ?? 'unknown';
  const bundle = bundleName ? spec.configBundles?.find(cb => cb.name === bundleName) : undefined;
  if (!bundle) {
    return {
      success: false,
      error: new ResourceNotFoundError(`Config bundle "${identifier}" not found in agentcore.json.`),
    };
  }

  // Update local bundle components to match the server's new version
  bundle.components = newVersion.components as typeof bundle.components;

  // Update commit message from lineage metadata if available
  if (newVersion.lineageMetadata?.commitMessage) {
    bundle.commitMessage = newVersion.lineageMetadata.commitMessage;
  }

  // Write updated spec
  await configIO.writeProjectSpec(spec);

  // Update deployed state with the new version ID
  for (const targetName of Object.keys(deployedState.targets ?? {})) {
    const target = deployedState.targets?.[targetName];
    const bundleState = target?.resources?.configBundles?.[identifier];
    if (bundleState) {
      bundleState.versionId = resultBundle.versionId;
      break;
    }
  }
  await configIO.writeDeployedState(deployedState);

  return {
    success: true,
    newVersionId: resultBundle.versionId,
  };
}
