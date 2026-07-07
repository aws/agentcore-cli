/**
 * Build the CreateABTest request (variants + eval config + filters) and the persisted
 * variant summaries from the engine-facing StartABTestJobOptions. ARN/name resolution runs
 * against deployed state so a user can pass bundle/target/eval NAMES on the command line.
 */
import { ResourceNotFoundError, ValidationError } from '../../../../lib';
import type { DeployedResourceState } from '../../../../schema';
import type { ABTestEvaluationConfig, ABTestVariant, GatewayFilter } from '../../../aws/agentcore-ab-tests';
import type { ABTestVariantSummary, StartABTestJobOptions } from '../shared/types';
import { resolveConfigBundleArn, resolveConfigBundleVersion, resolveOnlineEvalArn } from './resolve';

export interface BuiltABTestRequest {
  variants: ABTestVariant[];
  evaluationConfig: ABTestEvaluationConfig;
  gatewayFilter?: GatewayFilter;
  /** Resolved summaries persisted on the record for display. */
  variantSummaries: ABTestVariantSummary[];
}

/** Resolve a gateway-target name. The L3 CDK construct deploys targets by their spec name as-is. */
function resolveTargetName(targetName: string): string {
  return targetName;
}

/**
 * Assemble the AB-test create request from start options. Throws ValidationError when a
 * mode's required inputs are missing (caught by the handler → `{ success: false }`).
 */
export function buildABTestRequest(
  opts: StartABTestJobOptions,
  deployedResources?: DeployedResourceState
): BuiltABTestRequest {
  const variants: ABTestVariant[] = [];
  const variantSummaries: ABTestVariantSummary[] = [];
  let evaluationConfig: ABTestEvaluationConfig;
  let gatewayFilter: GatewayFilter | undefined;

  if (opts.mode === 'config-bundle') {
    if (!opts.controlBundle || !opts.controlVersion || !opts.treatmentBundle || !opts.treatmentVersion) {
      throw new ValidationError('config-bundle A/B test requires control and treatment bundle names and versions.');
    }
    if (!opts.onlineEval) {
      throw new ValidationError('config-bundle A/B test requires an online-eval config.');
    }

    const controlArn = resolveConfigBundleArn(opts.controlBundle, deployedResources);
    const controlVer = resolveConfigBundleVersion(opts.controlBundle, opts.controlVersion, deployedResources);
    const treatmentArn = resolveConfigBundleArn(opts.treatmentBundle, deployedResources);
    const treatmentVer = resolveConfigBundleVersion(opts.treatmentBundle, opts.treatmentVersion, deployedResources);

    if (!controlArn) {
      throw new ResourceNotFoundError(
        `Config bundle "${opts.controlBundle}" is not deployed. Run \`agentcore add config-bundle\` and \`agentcore deploy\` first.`
      );
    }
    if (!controlVer) {
      throw new ResourceNotFoundError(
        `Could not resolve version "${opts.controlVersion}" for config bundle "${opts.controlBundle}". Use LATEST or a version UUID (e.g. a1b2c3d4-e5f6-7890-abcd-ef1234567890).`
      );
    }
    if (!treatmentArn) {
      throw new ResourceNotFoundError(
        `Config bundle "${opts.treatmentBundle}" is not deployed. Run \`agentcore add config-bundle\` and \`agentcore deploy\` first.`
      );
    }
    if (!treatmentVer) {
      throw new ResourceNotFoundError(
        `Could not resolve version "${opts.treatmentVersion}" for config bundle "${opts.treatmentBundle}". Use LATEST or a version UUID (e.g. a1b2c3d4-e5f6-7890-abcd-ef1234567890).`
      );
    }

    variants.push(
      {
        name: 'C',
        weight: opts.controlWeight,
        variantConfiguration: { configurationBundle: { bundleArn: controlArn, bundleVersion: controlVer } },
      },
      {
        name: 'T1',
        weight: opts.treatmentWeight,
        variantConfiguration: { configurationBundle: { bundleArn: treatmentArn, bundleVersion: treatmentVer } },
      }
    );
    variantSummaries.push(
      { name: 'C', weight: opts.controlWeight, bundleArn: controlArn, bundleVersion: controlVer },
      { name: 'T1', weight: opts.treatmentWeight, bundleArn: treatmentArn, bundleVersion: treatmentVer }
    );

    const onlineEvalArn = resolveOnlineEvalArn(opts.onlineEval, deployedResources);
    if (!onlineEvalArn) {
      throw new ResourceNotFoundError(
        `Online-eval config "${opts.onlineEval}" is not deployed. Run \`agentcore add online-eval\` and \`agentcore deploy\` first.`
      );
    }
    evaluationConfig = { onlineEvaluationConfigArn: onlineEvalArn };
  } else {
    // target-based
    if (!opts.controlTarget || !opts.treatmentTarget) {
      throw new ValidationError('target-based A/B test requires control and treatment target names.');
    }

    const controlName = resolveTargetName(opts.controlTarget);
    const treatmentName = resolveTargetName(opts.treatmentTarget);

    variants.push(
      { name: 'C', weight: opts.controlWeight, variantConfiguration: { target: { name: controlName } } },
      { name: 'T1', weight: opts.treatmentWeight, variantConfiguration: { target: { name: treatmentName } } }
    );
    variantSummaries.push(
      { name: 'C', weight: opts.controlWeight, targetName: controlName },
      { name: 'T1', weight: opts.treatmentWeight, targetName: treatmentName }
    );

    // Target-based mode always requires per-variant eval configs (each scoped to its endpoint).
    if (!opts.controlOnlineEval || !opts.treatmentOnlineEval) {
      throw new ValidationError(
        'target-based A/B test requires --control-online-eval and --treatment-online-eval (one per endpoint).'
      );
    }
    const controlEvalArn = resolveOnlineEvalArn(opts.controlOnlineEval, deployedResources);
    if (!controlEvalArn) {
      throw new ResourceNotFoundError(
        `Online-eval config "${opts.controlOnlineEval}" (--control-online-eval) is not deployed. Run \`agentcore add online-eval\` and \`agentcore deploy\` first.`
      );
    }
    const treatmentEvalArn = resolveOnlineEvalArn(opts.treatmentOnlineEval, deployedResources);
    if (!treatmentEvalArn) {
      throw new ResourceNotFoundError(
        `Online-eval config "${opts.treatmentOnlineEval}" (--treatment-online-eval) is not deployed. Run \`agentcore add online-eval\` and \`agentcore deploy\` first.`
      );
    }
    evaluationConfig = {
      perVariantOnlineEvaluationConfig: [
        { name: 'C', onlineEvaluationConfigArn: controlEvalArn },
        { name: 'T1', onlineEvaluationConfigArn: treatmentEvalArn },
      ],
    };
  }

  // Gateway filter applies to BOTH modes. The service allows exactly one target path; reject more.
  if (opts.gatewayFilter) {
    const targetPaths = opts.gatewayFilter
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (targetPaths.length > 1) {
      throw new ValidationError(
        `--gateway-filter accepts exactly one target path pattern (the service allows a single path). ` +
          `Got ${targetPaths.length}: ${targetPaths.map(p => `"${p}"`).join(', ')}.`
      );
    }
    if (targetPaths.length === 1) {
      gatewayFilter = { targetPaths: [targetPaths[0]!] };
    }
  }

  return { variants, evaluationConfig, gatewayFilter, variantSummaries };
}
