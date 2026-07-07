import { ConfigIO } from '../../../../lib';
import type { DeployedState } from '../../../../schema';
import { getConfigurationBundleVersion } from '../../../aws/agentcore-config-bundles';
import { resolveComponentKeyForJsonPath } from '../recommendation/build-config';
import { regionFromArn } from '../shared/region';
import type { ABTestJobRecord, ABTestVariantSummary } from '../shared/types';

/** Extract the bundle id (the ARN's resource suffix) from a configuration-bundle ARN. */
function bundleIdFromArn(arn: string): string | undefined {
  const id = arn.split('/').pop();
  return id && id.length > 0 ? id : undefined;
}

/**
 * Restore portable component keys when adopting service-returned components.
 *
 * The service keys a bundle version's components by resolved runtime/gateway ARN (account- and
 * region-specific). Writing those straight into agentcore.json would replace the committed,
 * portable `{{runtime:<name>}}` / `{{gateway:<name>}}` placeholders with hardcoded ARNs, breaking
 * cross-account/region reuse of the config. We rebuild the placeholder→ARN map from the LOCAL
 * bundle's existing keys (via the same resolver deploy uses) and invert it, so each incoming ARN
 * key is rewritten back to the placeholder the project already uses. ARNs with no matching local
 * placeholder are passed through unchanged.
 */
function restorePlaceholderKeys<T>(
  serviceComponents: Record<string, T>,
  localComponents: Record<string, T> | undefined,
  deployedState: DeployedState
): Record<string, T> {
  const arnToPlaceholder = new Map<string, string>();
  for (const key of Object.keys(localComponents ?? {})) {
    if (key.startsWith('arn:')) continue;
    const arn = resolveComponentKeyForJsonPath(key, deployedState);
    if (arn !== key) arnToPlaceholder.set(arn, key);
  }
  const remapped: Record<string, T> = {};
  for (const [key, value] of Object.entries(serviceComponents)) {
    remapped[arnToPlaceholder.get(key) ?? key] = value;
  }
  return remapped;
}

export interface PromoteABTestResult {
  promoted: boolean;
  mode?: string;
  promotionDetail: string;
}

/** Reverse-resolve a deployed config-bundle ARN to its spec name (the key in configBundles[]). */
function bundleNameFromArn(
  deployedState: { targets: Record<string, { resources?: { configBundles?: Record<string, { bundleArn: string }> } }> },
  bundleArn: string
): string | undefined {
  for (const target of Object.values(deployedState.targets)) {
    const bundles = target.resources?.configBundles;
    if (!bundles) continue;
    for (const [name, entry] of Object.entries(bundles)) {
      if (entry.bundleArn === bundleArn) return name;
    }
  }
  return undefined;
}

/**
 * Apply A/B test promotion to agentcore.json, sourcing the winning (treatment / T1) variant
 * from the job record's persisted `variants` — NOT from project.abTests[] (which the fire-and-forget
 * jobs model never populates). Does NOT stop the test — the handler does that first.
 *
 * - config-bundle mode: control and treatment must be two VERSIONS of the SAME bundle (different
 *   bundleArn → rejected). Adopts the treatment version's components into the bundle (fetched from
 *   the service); a later deploy version-bumps it, with lineage handled server-side.
 * - target-based mode:  if both variants are named endpoints of the same runtime, bump the control
 *   endpoint's version to the treatment endpoint's version (control keeps its identity). Otherwise
 *   (different runtimes, or the default unnamed endpoint) repoint the control target at whatever the
 *   treatment target serves by cloning its httpRuntime. Either way control ends up serving treatment.
 *
 * @param dryRun When true, performs the exact same resolution/validation but does NOT write
 *   agentcore.json. Lets the caller verify the winner is applicable BEFORE stopping the test, so a
 *   non-promotable test (e.g. target-based with a missing control/treatment target) fails fast
 *   without first stopping the running test. The `promoted` flag + `promotionDetail` are identical
 *   to a real run.
 */
export async function promoteABTestConfig(record: ABTestJobRecord, dryRun = false): Promise<PromoteABTestResult> {
  const configIO = new ConfigIO();
  const project = await configIO.readProjectSpec();
  const mode = record.mode;

  const control = record.variants.find((v: ABTestVariantSummary) => v.name === 'C');
  const treatment = record.variants.find((v: ABTestVariantSummary) => v.name === 'T1');
  if (!control || !treatment) {
    return {
      promoted: false,
      mode,
      promotionDetail: 'A/B test record is missing control (C) or treatment (T1) variant.',
    };
  }

  if (mode === 'target-based') {
    if (!record.gatewayName) {
      return {
        promoted: false,
        mode,
        promotionDetail: 'A/B test record is missing the gateway name; cannot locate targets.',
      };
    }
    const gateway = (project.agentCoreGateways ?? []).find(g => g.name === record.gatewayName);
    if (!gateway?.targets) {
      return { promoted: false, mode, promotionDetail: `Gateway "${record.gatewayName}" not found in agentcore.json.` };
    }
    const controlTarget = gateway.targets.find(t => t.name === control.targetName);
    const treatmentTarget = gateway.targets.find(t => t.name === treatment.targetName);
    // Control must exist (we write to it); treatment must have a runtime to copy from. These are the
    // only genuinely unpromotable cases — a missing target means there is nothing to apply.
    if (!controlTarget?.httpRuntime?.runtime || !treatmentTarget?.httpRuntime?.runtime) {
      return {
        promoted: false,
        mode,
        promotionDetail: 'Could not resolve control/treatment runtime targets for promotion.',
      };
    }

    // Fast path: both variants are named endpoints of the SAME runtime, differing only by version.
    // Promote by bumping control's endpoint version to treatment's — control keeps its identity.
    const sameRuntime = controlTarget.httpRuntime.runtime === treatmentTarget.httpRuntime.runtime;
    const controlEpName = controlTarget.httpRuntime.runtimeEndpoint;
    const treatmentEpName = treatmentTarget.httpRuntime.runtimeEndpoint;
    if (sameRuntime && controlEpName && treatmentEpName) {
      const runtime = project.runtimes.find(r => r.name === controlTarget.httpRuntime!.runtime);
      const controlEp = runtime?.endpoints?.[controlEpName];
      const treatmentEp = runtime?.endpoints?.[treatmentEpName];
      if (controlEp && treatmentEp) {
        if (!dryRun) {
          controlEp.version = treatmentEp.version;
          await configIO.writeProjectSpec(project);
        }
        return {
          promoted: true,
          mode,
          promotionDetail: `Control endpoint "${controlEpName}" updated to version ${treatmentEp.version} (from treatment "${treatmentEpName}").`,
        };
      }
    }

    // General path: control and treatment point at different runtimes, or use the default
    // (unnamed) endpoint, so there is no single version field to bump. Repoint the control target
    // at exactly what treatment serves by cloning its httpRuntime block.
    if (!dryRun) {
      controlTarget.httpRuntime = structuredClone(treatmentTarget.httpRuntime);
      await configIO.writeProjectSpec(project);
    }
    const treatmentRef = treatmentEpName
      ? `${treatmentTarget.httpRuntime.runtime} (endpoint "${treatmentEpName}")`
      : treatmentTarget.httpRuntime.runtime;
    return {
      promoted: true,
      mode,
      promotionDetail: `Control target "${controlTarget.name}" repointed to treatment runtime ${treatmentRef}.`,
    };
  }

  // config-bundle mode: the control bundle adopts the WINNING (treatment) version's components.
  if (!control.bundleArn || !treatment.bundleArn) {
    return { promoted: false, mode, promotionDetail: 'A/B test record is missing control/treatment bundle ARNs.' };
  }

  // Promote is only coherent when control and treatment are two VERSIONS of the SAME bundle.
  // A ConfigurationBundle version bump is parented to the same bundle's prior version (the service
  // tracks lineage per bundle), so "promote treatment into control" means adopting the treatment
  // VERSION's components into that one bundle. Two different bundles have independent lineages and
  // cannot be promoted into one another — reject that up front.
  if (control.bundleArn !== treatment.bundleArn) {
    return {
      promoted: false,
      mode,
      promotionDetail:
        'Cannot promote: control and treatment reference different config bundles. ' +
        'A config-bundle A/B test can only promote between two versions of the SAME bundle.',
    };
  }

  if (!treatment.bundleVersion) {
    return {
      promoted: false,
      mode,
      promotionDetail: 'A/B test record is missing the treatment bundle version; cannot promote.',
    };
  }

  let controlName: string | undefined;
  let deployedState: DeployedState | undefined;
  try {
    deployedState = await configIO.readDeployedState();
    controlName = bundleNameFromArn(deployedState, control.bundleArn);
  } catch {
    // deployed state unavailable
  }
  if (!controlName || !deployedState) {
    return {
      promoted: false,
      mode,
      promotionDetail: 'Could not resolve the config bundle from deployed state (deploy the bundle first).',
    };
  }

  const controlBundle = (project.configBundles ?? []).find(b => b.name === controlName);
  if (!controlBundle) {
    return {
      promoted: false,
      mode,
      promotionDetail: `Could not find config bundle "${controlName}" in agentcore.json.`,
    };
  }

  const bundleId = bundleIdFromArn(treatment.bundleArn);
  if (!bundleId) {
    return { promoted: false, mode, promotionDetail: `Could not parse bundle id from ARN "${treatment.bundleArn}".` };
  }

  // Fetch the winning (treatment) version's components from the service and adopt them locally.
  // A subsequent `agentcore deploy` version-bumps the bundle (lineage handled server-side).
  if (!dryRun) {
    const region = regionFromArn(treatment.bundleArn) ?? regionFromArn(record.arn);
    if (!region) {
      return { promoted: false, mode, promotionDetail: 'Could not determine region for the config bundle.' };
    }
    const winning = await getConfigurationBundleVersion({
      region,
      bundleId,
      versionId: treatment.bundleVersion,
    });
    // Service keys components by resolved ARN; restore the bundle's portable {{runtime:...}}
    // placeholders so the committed config stays cross-account/region portable.
    controlBundle.components = restorePlaceholderKeys(
      winning.components as Record<string, unknown>,
      controlBundle.components as Record<string, unknown>,
      deployedState
    ) as typeof controlBundle.components;
    await configIO.writeProjectSpec(project);
  }
  return {
    promoted: true,
    mode,
    promotionDetail: `Config bundle "${controlName}" updated to the winning version ${treatment.bundleVersion}.`,
  };
}
