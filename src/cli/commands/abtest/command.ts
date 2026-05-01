/**
 * AB Test commands.
 *
 * `agentcore ab-test <name>` — fetches and displays full AB test details
 * from the data plane API, including evaluation scores/metrics.
 */
import { ConfigIO } from '../../../lib';
import { getABTest, listABTests } from '../../aws/agentcore-ab-tests';
import type { GetABTestResult } from '../../aws/agentcore-ab-tests';
import { dnsSuffix } from '../../aws/partition';
import { getErrorMessage } from '../../errors';
import type { Command } from '@commander-js/extra-typings';

// ============================================================================
// Helpers
// ============================================================================

async function getRegion(cliRegion?: string): Promise<string> {
  if (cliRegion) return cliRegion;
  try {
    const configIO = new ConfigIO();
    const targets = await configIO.resolveAWSDeploymentTargets();
    if (targets.length > 0) return targets[0]!.region;
  } catch {
    // Fall through to env vars
  }
  return process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';
}

async function resolveABTestId(
  testName: string,
  region: string
): Promise<{ abTestId: string; region: string; error?: string }> {
  let projectName: string | undefined;
  try {
    const configIO = new ConfigIO();
    const deployedState = await configIO.readDeployedState();
    const awsTargets = await configIO.readAWSDeploymentTargets();

    try {
      const projectSpec = await configIO.readProjectSpec();
      projectName = projectSpec.name;
    } catch {
      // Project spec unavailable
    }

    for (const [targetName, target] of Object.entries(deployedState.targets ?? {})) {
      const abTests = target.resources?.abTests;
      if (abTests?.[testName]) {
        const targetConfig = awsTargets.find(t => t.name === targetName);
        const resolvedRegion = targetConfig?.region ?? region;
        return { abTestId: abTests[testName].abTestId, region: resolvedRegion };
      }
    }
  } catch {
    // No deployed state available
  }

  try {
    const result = await listABTests({ region, maxResults: 100 });
    // Match against both prefixed name ({projectName}_{testName}) and bare testName (backwards compat)
    const prefixedName = projectName ? `${projectName}_${testName}` : undefined;
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- boolean OR, not nullish coalescing
    const match = result.abTests.find(t => (prefixedName && t.name === prefixedName) || t.name === testName);
    if (match) {
      return { abTestId: match.abTestId, region };
    }
  } catch {
    // API call failed
  }

  return { abTestId: '', region, error: `AB test "${testName}" not found in deployed state or API.` };
}

function gatewayUrlFromArn(arn: string): string {
  const parts = arn.split(':');
  const region = parts[3];
  const gatewayId = parts[5]?.split('/')[1];
  if (region && gatewayId) {
    return `https://${gatewayId}.gateway.bedrock-agentcore.${region}.${dnsSuffix(region)}`;
  }
  return arn;
}

function formatABTestDetails(test: GetABTestResult): string {
  const lines: string[] = [];
  lines.push(`AB Test: ${test.name}`);
  lines.push(`  Status: ${test.status}`);
  lines.push(`  Execution: ${test.executionStatus}`);
  lines.push(`  Invocation URL: ${gatewayUrlFromArn(test.gatewayArn)}/<target>/invocations`);
  lines.push(
    `  Online Eval: ${'onlineEvaluationConfigArn' in test.evaluationConfig ? test.evaluationConfig.onlineEvaluationConfigArn : 'per-variant'}`
  );
  if (test.description) lines.push(`  Description: ${test.description}`);

  for (const variant of test.variants) {
    const bundleRef = variant.variantConfiguration.configurationBundle;
    const targetRef = variant.variantConfiguration.target;
    if (targetRef) {
      lines.push(`  Variant ${variant.name}: weight=${variant.weight}, target=${targetRef.name}`);
    } else if (bundleRef) {
      lines.push(
        `  Variant ${variant.name}: weight=${variant.weight}, bundle=${bundleRef.bundleArn}, version=${bundleRef.bundleVersion}`
      );
    }
  }

  // TODO(post-preview): Re-enable max duration display once configurable duration is launched.
  // if (test.maxDurationDays) lines.push(`  Max Duration: ${test.maxDurationDays} days`);
  if (test.startedAt) lines.push(`  Started: ${test.startedAt}`);
  if (test.stoppedAt) lines.push(`  Stopped: ${test.stoppedAt}`);
  if (test.failureReason) lines.push(`  Failure: ${test.failureReason}`);

  if (test.results) {
    lines.push('  Results:');
    if (test.results.analysisTimestamp) {
      lines.push(`    Analysis Time: ${test.results.analysisTimestamp}`);
    }
    for (const metric of test.results.evaluatorMetrics) {
      lines.push(`    Evaluator: ${metric.evaluatorArn}`);
      lines.push(
        `      Control: samples=${metric.controlStats.sampleSize}, mean=${metric.controlStats.mean.toFixed(4)}`
      );
      for (const vr of metric.variantResults) {
        lines.push(
          `      ${vr.treatmentName}: samples=${vr.sampleSize}, mean=${vr.mean.toFixed(4)}, significant=${vr.isSignificant}`
        );
        if (vr.absoluteChange !== undefined)
          lines.push(`        Change: ${vr.absoluteChange.toFixed(4)} (${(vr.percentChange ?? 0).toFixed(2)}%)`);
        if (vr.pValue !== undefined) lines.push(`        p-value: ${vr.pValue.toFixed(6)}`);
        if (vr.confidenceInterval) {
          lines.push(
            `        CI: [${vr.confidenceInterval.lower?.toFixed(4)}, ${vr.confidenceInterval.upper?.toFixed(4)}]`
          );
        }
      }
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Command registration
// ============================================================================

export function registerABTestCommand(program: Command): void {
  program
    .command('ab-test')
    .description('[preview] View A/B test details and results')
    .argument('<name>', 'AB test name')
    .option('--region <region>', 'AWS region')
    .option('--json', 'Output as JSON')
    .action(async (name: string, cliOptions: { region?: string; json?: boolean }) => {
      try {
        const region = await getRegion(cliOptions.region);
        const { abTestId, error } = await resolveABTestId(name, region);
        if (error) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error }));
          } else {
            console.error(error);
          }
          process.exit(1);
        }
        const result = await getABTest({ region, abTestId });

        if (cliOptions.json) {
          console.log(JSON.stringify(result));
          process.exit(0);
        } else if (process.stdout.isTTY) {
          // Render TUI detail screen with key bindings
          const [{ render }, { default: React }, { ABTestDetailScreen }] = await Promise.all([
            import('ink'),
            import('react'),
            import('../../tui/screens/ab-test'),
          ]);
          render(
            React.createElement(ABTestDetailScreen, {
              abTestId,
              region,
              onExit: () => process.exit(0),
            })
          );
          return;
        } else {
          console.log(formatABTestDetails(result));
          process.exit(0);
        }
      } catch (error) {
        if (cliOptions.json) {
          console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
        } else {
          console.error(`Error: ${getErrorMessage(error)}`);
        }
        process.exit(1);
      }
    });
}
