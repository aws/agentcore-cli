/**
 * Resolves a config bundle name to its bundle ID.
 *
 * Fast path: reads deployed-state.json for known bundle IDs.
 * Fallback: calls listConfigurationBundles API to find by name.
 */
import { ConfigIO } from '../../../lib';
import { listConfigurationBundleVersions, listConfigurationBundles } from '../../aws/agentcore-config-bundles';
import { getBundleNameVariants } from './bundle-name-variants';

export interface ResolvedBundle {
  bundleId: string;
  bundleArn?: string;
  versionId?: string;
  region: string;
}

/**
 * Resolve a bundle name to its API identifiers.
 * Tries deployed-state.json first, then falls back to list API.
 */
export async function resolveBundleByName(
  bundleName: string,
  region: string,
  configIO: ConfigIO = new ConfigIO()
): Promise<ResolvedBundle> {
  // Fast path: check deployed state
  const deployedState = await configIO.readDeployedState();
  for (const targetName of Object.keys(deployedState.targets ?? {})) {
    const target = deployedState.targets?.[targetName];
    const bundles = target?.resources?.configBundles;
    const bundle = bundles?.[bundleName];
    if (bundle) {
      // Verify the bundle still exists by listing versions (branch-agnostic)
      try {
        const versions = await listConfigurationBundleVersions({
          region,
          bundleId: bundle.bundleId,
          maxResults: 1,
        });
        const latestVersion = versions.versions[0];
        return {
          bundleId: bundle.bundleId,
          bundleArn: bundle.bundleArn,
          versionId: latestVersion?.versionId ?? bundle.versionId,
          region,
        };
      } catch {
        // Stale deployed-state entry — fall through to API lookup
      }
    }
  }

  // Fallback: search via API
  // The API stores bundles with a prefixed name: {projectName}{bundleName}
  let projectName: string | undefined;
  try {
    const projectSpec = await configIO.readProjectSpec();
    projectName = projectSpec.name;
  } catch {
    // Project spec may not be available
  }

  const nameVariants = getBundleNameVariants(bundleName, projectName);
  let nextToken: string | undefined;
  let match: { bundleId: string; bundleArn: string; bundleName: string } | undefined;
  do {
    const page = await listConfigurationBundles({ region, maxResults: 100, nextToken });
    match = page.bundles.find(b => nameVariants.includes(b.bundleName));
    nextToken = page.nextToken;
  } while (!match && nextToken);

  if (!match) {
    throw new Error(`Configuration bundle "${bundleName}" not found. Has it been deployed?`);
  }

  // Get the latest version ID (branch-agnostic)
  const versions = await listConfigurationBundleVersions({
    region,
    bundleId: match.bundleId,
    maxResults: 1,
  });
  const latestVersion = versions.versions[0];

  return {
    bundleId: match.bundleId,
    bundleArn: match.bundleArn,
    versionId: latestVersion?.versionId,
    region,
  };
}
