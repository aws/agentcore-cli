import type { AgentCoreProjectSpec, ConfigBundleDeployedState, DeployedState } from '../../../schema';
import {
  createConfigurationBundle,
  deleteConfigurationBundle,
  getConfigurationBundleVersion,
  listConfigurationBundleVersions,
  listConfigurationBundles,
  updateConfigurationBundle,
} from '../../aws/agentcore-config-bundles';
import type { ComponentConfigurationMap } from '../../aws/agentcore-config-bundles';

// ============================================================================
// Types
// ============================================================================

export interface SetupConfigBundlesOptions {
  region: string;
  projectSpec: AgentCoreProjectSpec;
  /** Existing config bundle deployed state (from deployed-state.json) */
  existingBundles?: Record<string, ConfigBundleDeployedState>;
}

export interface ConfigBundleSetupResult {
  bundleName: string;
  status: 'created' | 'updated' | 'deleted' | 'skipped' | 'error';
  bundleId?: string;
  bundleArn?: string;
  versionId?: string;
  error?: string;
}

export interface SetupConfigBundlesResult {
  results: ConfigBundleSetupResult[];
  /** Deployed state entries for config bundles (to merge into deployed-state.json) */
  configBundles: Record<string, ConfigBundleDeployedState>;
  hasErrors: boolean;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Create, update, or delete configuration bundles post-deploy.
 *
 * Pattern:
 * 1. For each configBundle in project spec → create or update
 * 2. For each bundle in deployed-state but NOT in project spec → delete (reconciliation)
 * 3. Return updated deployed state entries
 */
export async function setupConfigBundles(options: SetupConfigBundlesOptions): Promise<SetupConfigBundlesResult> {
  const { region, projectSpec, existingBundles } = options;
  const results: ConfigBundleSetupResult[] = [];
  const configBundles: Record<string, ConfigBundleDeployedState> = {};

  const specBundleNames = new Set((projectSpec.configBundles ?? []).map(b => b.name));
  const projectName = projectSpec.name;

  // Create or update bundles from the spec
  for (const bundleSpec of projectSpec.configBundles ?? []) {
    // Prepend project name to the API-side bundle name (no separator for config bundles)
    const apiBundleName = `${projectName}${bundleSpec.name}`;

    try {
      // Try to update if we have an existing bundle ID
      const existingBundle = existingBundles?.[bundleSpec.name];
      let updated = false;

      if (existingBundle) {
        try {
          // Fetch the exact version we know about — avoids branch-not-found errors
          const current = await getConfigurationBundleVersion({
            region,
            bundleId: existingBundle.bundleId,
            versionId: existingBundle.versionId,
          });
          const componentsChanged = !deepEqual(current.components, bundleSpec.components);
          const descriptionChanged = (bundleSpec.description ?? undefined) !== (current.description ?? undefined);

          if (!componentsChanged && !descriptionChanged) {
            // Nothing changed — skip the update, preserve existing state
            configBundles[bundleSpec.name] = {
              bundleId: existingBundle.bundleId,
              bundleArn: existingBundle.bundleArn,
              versionId: existingBundle.versionId,
            };
            results.push({
              bundleName: bundleSpec.name,
              status: 'skipped',
              bundleId: existingBundle.bundleId,
              bundleArn: existingBundle.bundleArn,
              versionId: existingBundle.versionId,
            });
            updated = true;
          } else {
            // Use the branch from the spec, or fall back to whatever branch the API has
            const effectiveBranch = bundleSpec.branchName ?? current.lineageMetadata?.branchName ?? 'mainline';
            const result = await updateConfigurationBundle({
              region,
              bundleId: existingBundle.bundleId,
              description: bundleSpec.description,
              components: bundleSpec.components as ComponentConfigurationMap,
              parentVersionIds: [current.versionId],
              branchName: effectiveBranch,
              commitMessage: bundleSpec.commitMessage ?? `Update ${bundleSpec.name}`,
            });

            configBundles[bundleSpec.name] = {
              bundleId: result.bundleId,
              bundleArn: result.bundleArn,
              versionId: result.versionId,
            };

            results.push({
              bundleName: bundleSpec.name,
              status: 'updated',
              bundleId: result.bundleId,
              bundleArn: result.bundleArn,
              versionId: result.versionId,
            });
            updated = true;
          }
        } catch (updateErr) {
          // If bundle or branch not found, fall through to find-by-name or create
          const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
          if (!msg.includes('404') && !msg.includes('not found')) throw updateErr;
        }
      }

      if (!updated) {
        // Try to find by name via list (handles re-creation after state loss)
        const existingByName = await findBundleByName(region, apiBundleName);

        if (existingByName) {
          // Fetch versions and pick the newest — avoids branch-not-found errors from getConfigurationBundle
          const versions = await listConfigurationBundleVersions({
            region,
            bundleId: existingByName.bundleId,
          });
          const sorted = [...versions.versions].sort((a, b) => Number(b.versionCreatedAt) - Number(a.versionCreatedAt));
          const latestVersionId = sorted[0]?.versionId;
          if (!latestVersionId) throw new Error(`No versions found for bundle ${bundleSpec.name}`);
          const current = await getConfigurationBundleVersion({
            region,
            bundleId: existingByName.bundleId,
            versionId: latestVersionId,
          });
          const componentsChanged = !deepEqual(current.components, bundleSpec.components);
          const descriptionChanged = (bundleSpec.description ?? undefined) !== (current.description ?? undefined);

          if (!componentsChanged && !descriptionChanged) {
            configBundles[bundleSpec.name] = {
              bundleId: existingByName.bundleId,
              bundleArn: current.bundleArn,
              versionId: current.versionId,
            };
            results.push({
              bundleName: bundleSpec.name,
              status: 'skipped',
              bundleId: existingByName.bundleId,
              bundleArn: current.bundleArn,
              versionId: current.versionId,
            });
          } else {
            const effectiveBranch = bundleSpec.branchName ?? current.lineageMetadata?.branchName ?? 'mainline';
            const result = await updateConfigurationBundle({
              region,
              bundleId: existingByName.bundleId,
              description: bundleSpec.description,
              components: bundleSpec.components as ComponentConfigurationMap,
              parentVersionIds: [current.versionId],
              branchName: effectiveBranch,
              commitMessage: bundleSpec.commitMessage ?? `Update ${bundleSpec.name}`,
            });

            configBundles[bundleSpec.name] = {
              bundleId: result.bundleId,
              bundleArn: result.bundleArn,
              versionId: result.versionId,
            };

            results.push({
              bundleName: bundleSpec.name,
              status: 'updated',
              bundleId: result.bundleId,
              bundleArn: result.bundleArn,
              versionId: result.versionId,
            });
          }
        } else {
          // Create new — omit branchName if not in spec so the API uses its default
          const result = await createConfigurationBundle({
            region,
            bundleName: apiBundleName,
            description: bundleSpec.description,
            components: bundleSpec.components as ComponentConfigurationMap,
            branchName: bundleSpec.branchName,
            commitMessage: bundleSpec.commitMessage ?? `Create ${bundleSpec.name}`,
          });

          configBundles[bundleSpec.name] = {
            bundleId: result.bundleId,
            bundleArn: result.bundleArn,
            versionId: result.versionId,
          };

          results.push({
            bundleName: bundleSpec.name,
            status: 'created',
            bundleId: result.bundleId,
            bundleArn: result.bundleArn,
            versionId: result.versionId,
          });
        }
      }
    } catch (err) {
      results.push({
        bundleName: bundleSpec.name,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Delete orphaned bundles (in deployed-state but removed from spec)
  if (existingBundles) {
    for (const [bundleName, bundleState] of Object.entries(existingBundles)) {
      if (!specBundleNames.has(bundleName)) {
        try {
          await deleteConfigurationBundle({
            region,
            bundleId: bundleState.bundleId,
          });

          results.push({
            bundleName,
            status: 'deleted',
          });
        } catch (err) {
          results.push({
            bundleName,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  return {
    results,
    configBundles,
    hasErrors: results.some(r => r.status === 'error'),
  };
}

// ============================================================================
// Helpers
// ============================================================================

async function findBundleByName(region: string, bundleName: string): Promise<{ bundleId: string } | undefined> {
  try {
    const result = await listConfigurationBundles({ region, maxResults: 100 });
    return result.bundles.find(b => b.bundleName === bundleName);
  } catch {
    return undefined;
  }
}

/** Key-order-independent deep-equal for JSON-serializable objects. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(key => key in bObj && deepEqual(aObj[key], bObj[key]));
}

// ============================================================================
// Component Key Resolution
// ============================================================================

/**
 * Resolve placeholder component keys (e.g., {{runtime:name}}, {{gateway:name}})
 * to actual ARNs from deployed state.
 */
export function resolveConfigBundleComponentKeys(
  projectSpec: AgentCoreProjectSpec,
  deployedState: DeployedState,
  targetName: string
): AgentCoreProjectSpec {
  const resources = deployedState.targets?.[targetName]?.resources;
  if (!resources) return projectSpec;

  const resolvedBundles = (projectSpec.configBundles ?? []).map(bundle => {
    const resolvedComponents: Record<string, { configuration: Record<string, unknown> }> = {};

    for (const [key, value] of Object.entries(bundle.components ?? {})) {
      const resolvedKey = resolveComponentKey(key, resources);
      resolvedComponents[resolvedKey] = value;
    }

    return { ...bundle, components: resolvedComponents };
  });

  return { ...projectSpec, configBundles: resolvedBundles };
}

function resolveComponentKey(
  key: string,
  resources: NonNullable<DeployedState['targets'][string]['resources']>
): string {
  if (key.startsWith('arn:')) return key;

  const gwMatch = /^\{\{gateway:(.+)\}\}$/.exec(key);
  if (gwMatch) {
    const gwName = gwMatch[1]!;
    const httpGw = resources.httpGateways?.[gwName];
    if (httpGw) return httpGw.gatewayArn;
    const mcpGw = resources.mcp?.gateways?.[gwName];
    if (mcpGw) return mcpGw.gatewayArn;
    throw new Error(
      `Config bundle references gateway "${gwName}" but it was not found in deployed resources. Ensure the gateway is defined in agentcore.json and deploys successfully.`
    );
  }

  const rtMatch = /^\{\{runtime:(.+)\}\}$/.exec(key);
  if (rtMatch) {
    const rtName = rtMatch[1]!;
    const rt = resources.runtimes?.[rtName];
    if (rt) return rt.runtimeArn;
    throw new Error(
      `Config bundle references runtime "${rtName}" but it was not found in deployed resources. Ensure the runtime is defined in agentcore.json and deploys successfully.`
    );
  }

  return key;
}
