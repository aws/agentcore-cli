import { ConfigIO } from '../../../lib';

export interface PromoteABTestResult {
  promoted: boolean;
  mode?: string;
  promotionDetail: string;
}

/**
 * Resolve the spec-level AB test name from a deployed abTestId.
 * Looks up which entry in deployed state has that abTestId and returns
 * the spec name (the key in the abTests record).
 */
function resolveSpecNameFromDeployedState(
  configIO: ConfigIO,
  deployedState: { targets: Record<string, { resources?: { abTests?: Record<string, { abTestId: string }> } }> },
  abTestId: string
): string | undefined {
  for (const target of Object.values(deployedState.targets)) {
    const abTests = target.resources?.abTests;
    if (!abTests) continue;
    for (const [specName, entry] of Object.entries(abTests)) {
      if (entry.abTestId === abTestId) {
        return specName;
      }
    }
  }
  return undefined;
}

/**
 * Apply AB test promotion to agentcore.json.
 * Updates the control variant's config to match the treatment variant.
 * Does NOT stop the AB test — caller is responsible for that.
 *
 * @param abTestId - The deployed AB test ID
 * @param testNameFallback - Optional name fallback when deployed state is unavailable
 */
export async function promoteABTestConfig(abTestId: string, testNameFallback?: string): Promise<PromoteABTestResult> {
  const configIO = new ConfigIO();
  const project = await configIO.readProjectSpec();

  // Try to resolve spec name from deployed state
  let specName: string | undefined;
  try {
    const deployedState = await configIO.readDeployedState();
    specName = resolveSpecNameFromDeployedState(configIO, deployedState, abTestId);
  } catch {
    // Deployed state unavailable
  }

  // Fall back to name-based lookup if deployed state didn't resolve
  if (!specName && testNameFallback) {
    console.warn(
      `[promote] Could not resolve AB test ID "${abTestId}" from deployed state; falling back to name "${testNameFallback}".`
    );
    const lowerName = testNameFallback.toLowerCase();
    const match = (project.abTests ?? []).find(
      t => t.name.toLowerCase() === lowerName || `${project.name}_${t.name}`.toLowerCase() === lowerName
    );
    specName = match?.name;
  }

  const abTest = specName ? (project.abTests ?? []).find(t => t.name === specName) : undefined;

  if (!abTest) {
    return { promoted: false, promotionDetail: `AB test with ID "${abTestId}" not found in project config.` };
  }

  const mode = abTest.mode ?? 'config-bundle';

  if (abTest.mode === 'target-based') {
    const treatmentVariant = abTest.variants.find(v => v.name === 'T1');
    const controlVariant = abTest.variants.find(v => v.name === 'C');
    const controlTargetName = controlVariant?.variantConfiguration.target?.targetName;
    const treatmentTargetName = treatmentVariant?.variantConfiguration.target?.targetName;

    const gwMatch = /^\{\{gateway:(.+)\}\}$/.exec(abTest.gatewayRef);
    const gwName = gwMatch?.[1];
    if (gwName) {
      const gw = (project.httpGateways ?? []).find(g => g.name === gwName);
      if (gw?.targets) {
        const controlTarget = gw.targets.find(t => t.name === controlTargetName);
        const treatmentTarget = gw.targets.find(t => t.name === treatmentTargetName);

        if (controlTarget && treatmentTarget) {
          const runtime = project.runtimes.find(r => r.name === controlTarget.runtimeRef);
          const controlEp = runtime?.endpoints?.[controlTarget.qualifier];
          const treatmentEp = runtime?.endpoints?.[treatmentTarget.qualifier];
          if (controlEp && treatmentEp) {
            controlEp.version = treatmentEp.version;
            await configIO.writeProjectSpec(project);
            return {
              promoted: true,
              mode,
              promotionDetail: `Control endpoint "${controlTarget.qualifier}" updated to version ${treatmentEp.version} (from treatment "${treatmentTarget.qualifier}").`,
            };
          }
        }
      }
    }
    return { promoted: false, mode, promotionDetail: 'Could not resolve target endpoints for promotion.' };
  }

  // Config-bundle mode
  const controlVariant = abTest.variants.find(v => v.name === 'C');
  const treatmentVariant = abTest.variants.find(v => v.name === 'T1');
  if (
    controlVariant?.variantConfiguration.configurationBundle &&
    treatmentVariant?.variantConfiguration.configurationBundle
  ) {
    controlVariant.variantConfiguration.configurationBundle = {
      ...treatmentVariant.variantConfiguration.configurationBundle,
    };
    await configIO.writeProjectSpec(project);
    return {
      promoted: true,
      mode,
      promotionDetail: `Control bundle updated to "${treatmentVariant.variantConfiguration.configurationBundle.bundleArn}" version "${treatmentVariant.variantConfiguration.configurationBundle.bundleVersion}".`,
    };
  }

  return { promoted: false, mode, promotionDetail: 'Could not resolve config bundles for promotion.' };
}
