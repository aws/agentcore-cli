import { ResourceNotFoundError, findConfigRoot, serializeResult, toError } from '../../lib';
import type { Result } from '../../lib/result';
import type { ABTest } from '../../schema/schemas/primitives/ab-test';
import { ABTestSchema } from '../../schema/schemas/primitives/ab-test';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { withCommandRunTelemetry } from '../telemetry/cli-command-run.js';
import { requireTTY } from '../tui/guards/tty';
import { BasePrimitive } from './BasePrimitive';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';

export type GatewayChoice = { type: 'create-new' } | { type: 'existing-http'; name: string };

export interface AddABTestOptions {
  name: string;
  description?: string;
  agent: string;
  gatewayChoice?: GatewayChoice;
  roleArn?: string;
  controlBundle: string;
  controlVersion: string;
  treatmentBundle: string;
  treatmentVersion: string;
  controlWeight: number;
  treatmentWeight: number;
  onlineEval: string;
  trafficHeaderName?: string;
  maxDurationDays?: number;
  enableOnCreate?: boolean;
}

export interface AddTargetBasedABTestOptions {
  name: string;
  description?: string;
  gateway: string;
  runtime: string;
  roleArn?: string;
  controlEndpoint: string;
  treatmentEndpoint: string;
  controlWeight: number;
  treatmentWeight: number;
  controlOnlineEval: string;
  treatmentOnlineEval: string;
  gatewayFilter?: string;
  enableOnCreate?: boolean;
}

export type RemovableABTest = RemovableResource;

/**
 * ABTestPrimitive handles all A/B test add/remove operations.
 *
 * A/B tests split traffic between two config bundle versions (control vs
 * treatment) through a gateway, with online evaluation tracking performance.
 * They are created via direct API calls (not CloudFormation) and stored in
 * agentcore.json for lifecycle management.
 */
export class ABTestPrimitive extends BasePrimitive<AddABTestOptions, RemovableABTest> {
  readonly kind = 'ab-test' as const;
  readonly label = 'AB Test';
  override readonly article = 'an';
  readonly primitiveSchema = ABTestSchema;

  async add(options: AddABTestOptions): Promise<AddResult<{ abTestName: string }>> {
    try {
      const abTest = await this.createABTest(options);
      return { success: true, abTestName: abTest.name };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async remove(testName: string, options?: { deleteGateway?: boolean }): Promise<Result> {
    try {
      const project = await this.readProjectSpec();

      const index = (project.abTests ?? []).findIndex(t => t.name === testName);
      if (index === -1) {
        return { success: false, error: new ResourceNotFoundError(`AB test "${testName}" not found.`) };
      }

      const removedTest = project.abTests[index]!;
      project.abTests.splice(index, 1);

      // Cascade: remove auto-created online eval configs for target-based tests
      // Only remove eval configs that were auto-created (matching the {testName}_eval_ prefix pattern)
      if (removedTest.mode === 'target-based' && 'perVariantOnlineEvaluationConfig' in removedTest.evaluationConfig) {
        const autoCreatedPrefix = `${testName}_eval_`;
        const evalNames = removedTest.evaluationConfig.perVariantOnlineEvaluationConfig
          .map(pv => pv.onlineEvaluationConfigArn)
          .filter(name => name.startsWith(autoCreatedPrefix));
        project.onlineEvalConfigs = project.onlineEvalConfigs.filter(c => !evalNames.includes(c.name));
      }

      // --delete-gateway: cascade remove gateway targets and orphaned gateways
      if (options?.deleteGateway && removedTest.gatewayRef) {
        const gwMatch = /^\{\{gateway:(.+)\}\}$/.exec(removedTest.gatewayRef);
        if (gwMatch) {
          const gwName = gwMatch[1]!;

          // Remove gateway targets that were created for this AB test's variants
          if (removedTest.mode === 'target-based') {
            const targetNames = removedTest.variants
              .map(v => v.variantConfiguration.target?.targetName)
              .filter((n): n is string => !!n);
            const gw = (project.httpGateways ?? []).find(g => g.name === gwName);
            if (gw?.targets) {
              gw.targets = gw.targets.filter(t => !targetNames.includes(t.name));
            }
          }

          // Remove gateway if no other AB tests reference it
          const stillReferenced = (project.abTests ?? []).some(t => {
            const m = /^\{\{gateway:(.+)\}\}$/.exec(t.gatewayRef);
            return m?.[1] === gwName;
          });
          if (!stillReferenced) {
            project.httpGateways = (project.httpGateways ?? []).filter(gw => gw.name !== gwName);
          }
        }
      }

      await this.writeProjectSpec(project);

      return { success: true };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async previewRemove(testName: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();

    const abTest = (project.abTests ?? []).find(t => t.name === testName);
    if (!abTest) {
      throw new Error(`AB test "${testName}" not found.`);
    }

    const summary: string[] = [`Removing AB test: ${testName}`];
    const schemaChanges: SchemaChange[] = [];

    const testIndex = (project.abTests ?? []).findIndex(t => t.name === testName);
    const afterSpec = {
      ...project,
      abTests: (project.abTests ?? []).filter(t => t.name !== testName),
      httpGateways: [...(project.httpGateways ?? [])],
    };

    // Check if the gateway would be orphaned
    const test = (project.abTests ?? [])[testIndex];
    if (test?.gatewayRef) {
      const gwMatch = /^\{\{gateway:(.+)\}\}$/.exec(test.gatewayRef);
      if (gwMatch) {
        const gwName = gwMatch[1];
        const otherTests = (project.abTests ?? []).filter((_, i) => i !== testIndex);
        const stillReferenced = otherTests.some(t => {
          const m = /^\{\{gateway:(.+)\}\}$/.exec(t.gatewayRef);
          return m && m[1] === gwName;
        });
        if (!stillReferenced) {
          summary.push(`Also removing HTTP gateway: ${gwName} (no other AB tests reference it)`);
          afterSpec.httpGateways = (project.httpGateways ?? []).filter(gw => gw.name !== gwName);
        }
      }
    }

    schemaChanges.push({
      file: 'agentcore/agentcore.json',
      before: project,
      after: afterSpec,
    });

    return { summary, directoriesToDelete: [], schemaChanges };
  }

  async getRemovable(): Promise<RemovableABTest[]> {
    try {
      const project = await this.readProjectSpec();
      return (project.abTests ?? []).map(t => ({ name: t.name }));
    } catch {
      return [];
    }
  }

  async getAllNames(): Promise<string[]> {
    try {
      const project = await this.readProjectSpec();
      return (project.abTests ?? []).map(t => t.name);
    } catch {
      return [];
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    const abTestCmd = addCmd
      .command('ab-test')
      .description('[preview] Add an A/B test to the project')
      .option('--mode <mode>', 'config-bundle (default) or target-based')
      .option('--name <name>', 'AB test name')
      .option('--description <text>', 'AB test description')
      .option('--runtime <name>', 'Runtime agent to A/B test')
      .option('--role-arn <arn>', 'IAM role ARN (auto-created if not provided)')
      .option('--control-bundle <name>', 'Control config bundle name or ARN')
      .option('--control-version <id>', 'Control config bundle version')
      .option('--treatment-bundle <name>', 'Treatment config bundle name or ARN')
      .option('--treatment-version <id>', 'Treatment config bundle version')
      .option('--control-endpoint <endpoint>', 'Endpoint qualifier for control')
      .option('--treatment-endpoint <endpoint>', 'Endpoint qualifier for treatment')
      .option('--control-weight <n>', 'Traffic weight for control (1-100)', parseInt)
      .option('--treatment-weight <n>', 'Traffic weight for treatment (1-100)', parseInt)
      .option('--gateway <name>', 'HTTP gateway name')
      .option('--online-eval <name>', 'Online evaluation config name or ARN')
      .option('--control-online-eval <name>', 'Eval config name or ARN for control')
      .option('--treatment-online-eval <name>', 'Eval config name or ARN for treatment')
      .option('--gateway-filter <pattern>', 'Path pattern for routing')
      .option('--traffic-header <name>', 'Header name for traffic routing')
      // Hidden deprecated aliases for backwards compatibility
      .option('--control-qualifier <endpoint>', '')
      .option('--treatment-qualifier <endpoint>', '')
      // TODO(post-preview): Re-enable --max-duration once configurable duration is launched.
      // .option('--max-duration <days>', 'Maximum duration in days (1-90)', parseInt)
      .option('--enable', 'Enable the AB test on creation')
      .option('--json', 'Output as JSON');

    // Hide mode-specific and deprecated flags from the default options list.
    // They are shown in the grouped help text below instead.
    const hiddenFromDefaultHelp = new Set([
      '--runtime',
      '--control-bundle',
      '--control-version',
      '--treatment-bundle',
      '--treatment-version',
      '--online-eval',
      '--traffic-header',
      '--control-endpoint',
      '--treatment-endpoint',
      '--control-online-eval',
      '--treatment-online-eval',
      '--gateway-filter',
      '--control-qualifier',
      '--treatment-qualifier',
    ]);
    for (const opt of abTestCmd.options) {
      if (hiddenFromDefaultHelp.has(opt.long ?? '')) {
        opt.hidden = true;
      }
    }

    // Add grouped help text after the default options section
    abTestCmd.addHelpText(
      'after',
      `
Config-Bundle Mode (--mode config-bundle) -- default
  Split traffic between two config bundle versions.
  --runtime <name>                 Runtime agent to A/B test
  --control-bundle <name>          Control config bundle name or ARN
  --control-version <id>           Control config bundle version
  --treatment-bundle <name>        Treatment config bundle name or ARN
  --treatment-version <id>         Treatment config bundle version
  --online-eval <name>             Online evaluation config name or ARN
  --traffic-header <name>          Header name for traffic routing

Target-Based Mode (--mode target-based)
  Route traffic to different runtime endpoints.
  --control-endpoint <endpoint>    Endpoint for control target
  --treatment-endpoint <endpoint>  Endpoint for treatment target
  --control-online-eval <name>     Eval config name or ARN for control
  --treatment-online-eval <name>   Eval config name or ARN for treatment
  --gateway-filter <pattern>       Path pattern for routing
`
    );

    abTestCmd.action(
      async (cliOptions: {
        mode?: string;
        name?: string;
        description?: string;
        runtime?: string;
        gateway?: string;
        roleArn?: string;
        controlBundle?: string;
        controlVersion?: string;
        treatmentBundle?: string;
        treatmentVersion?: string;
        controlEndpoint?: string;
        controlQualifier?: string; // deprecated alias for --control-endpoint
        treatmentEndpoint?: string;
        treatmentQualifier?: string; // deprecated alias for --treatment-endpoint
        controlWeight?: number;
        treatmentWeight?: number;
        onlineEval?: string;
        controlOnlineEval?: string;
        treatmentOnlineEval?: string;
        gatewayFilter?: string;
        trafficHeader?: string;
        maxDuration?: number;
        enable?: boolean;
        json?: boolean;
      }) => {
        try {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          // Resolve deprecated aliases (--control-qualifier -> --control-endpoint, etc.)
          const resolvedControlEndpoint = cliOptions.controlEndpoint ?? cliOptions.controlQualifier;
          const resolvedTreatmentEndpoint = cliOptions.treatmentEndpoint ?? cliOptions.treatmentQualifier;

          if (cliOptions.name || cliOptions.json) {
            const fail = (error: string) => {
              if (cliOptions.json) {
                console.log(JSON.stringify({ success: false, error }));
              } else {
                console.error(error);
              }
              process.exit(1);
            };

            const mode = cliOptions.mode ?? 'config-bundle';
            if (mode !== 'config-bundle' && mode !== 'target-based') {
              fail(`Invalid --mode "${mode}". Must be one of: config-bundle, target-based`);
            }

            if (!cliOptions.name) fail('--name is required');

            // Target-based mode
            if (mode === 'target-based') {
              // Cross-validation: reject config-bundle flags
              if (cliOptions.controlBundle) fail('--control-bundle cannot be used with --mode target-based');
              if (cliOptions.treatmentBundle) fail('--treatment-bundle cannot be used with --mode target-based');
              if (cliOptions.controlVersion) fail('--control-version cannot be used with --mode target-based');
              if (cliOptions.treatmentVersion) fail('--treatment-version cannot be used with --mode target-based');
              if (cliOptions.onlineEval) fail('--online-eval cannot be used with --mode target-based');

              // Required flags
              if (!cliOptions.gateway) fail('--gateway is required for target-based mode');
              if (!cliOptions.runtime) fail('--runtime is required for target-based mode');
              if (!resolvedControlEndpoint) fail('--control-endpoint is required for target-based mode');
              if (!resolvedTreatmentEndpoint) fail('--treatment-endpoint is required for target-based mode');
              if (cliOptions.controlWeight === undefined) fail('--control-weight is required');
              if (cliOptions.treatmentWeight === undefined) fail('--treatment-weight is required');

              // Eval: require both online eval config names
              if (!cliOptions.controlOnlineEval || !cliOptions.treatmentOnlineEval) {
                fail(
                  '--control-online-eval and --treatment-online-eval are required. Create eval configs first with: agentcore add online-eval --endpoint <name>'
                );
              }

              const result = await this.addTargetBased({
                name: cliOptions.name!,
                description: cliOptions.description,
                gateway: cliOptions.gateway!,
                runtime: cliOptions.runtime!,
                roleArn: cliOptions.roleArn,
                controlEndpoint: resolvedControlEndpoint!,
                treatmentEndpoint: resolvedTreatmentEndpoint!,
                controlWeight: cliOptions.controlWeight!,
                treatmentWeight: cliOptions.treatmentWeight!,
                controlOnlineEval: cliOptions.controlOnlineEval!,
                treatmentOnlineEval: cliOptions.treatmentOnlineEval!,
                gatewayFilter: cliOptions.gatewayFilter,
                enableOnCreate: cliOptions.enable,
              });

              if (cliOptions.json) {
                console.log(JSON.stringify(serializeResult(result)));
              } else if (result.success) {
                console.log(`Added target-based AB test '${result.abTestName}'`);
              } else {
                console.error(result.error.message);
              }
              process.exit(result.success ? 0 : 1);
              return;
            }

            // Config-bundle mode (default)
            // Cross-validation: reject target-based flags
            if (cliOptions.gatewayFilter) fail('--gateway-filter requires --mode target-based');
            if (cliOptions.controlOnlineEval) fail('--control-online-eval requires --mode target-based');
            if (cliOptions.treatmentOnlineEval) fail('--treatment-online-eval requires --mode target-based');

            if (!cliOptions.gateway && !cliOptions.runtime)
              fail('--runtime is required (unless --gateway is provided)');
            if (!cliOptions.controlBundle) fail('--control-bundle is required');
            if (!cliOptions.controlVersion) fail('--control-version is required');
            if (!cliOptions.treatmentBundle) fail('--treatment-bundle is required');
            if (!cliOptions.treatmentVersion) fail('--treatment-version is required');
            if (cliOptions.controlWeight === undefined) fail('--control-weight is required');
            if (cliOptions.treatmentWeight === undefined) fail('--treatment-weight is required');
            if (!cliOptions.onlineEval) fail('--online-eval is required');

            const result = await this.add({
              name: cliOptions.name!,
              description: cliOptions.description,
              agent: cliOptions.runtime ?? '',
              gatewayChoice: cliOptions.gateway
                ? { type: 'existing-http', name: cliOptions.gateway }
                : { type: 'create-new' },
              roleArn: cliOptions.roleArn!,
              controlBundle: cliOptions.controlBundle!,
              controlVersion: cliOptions.controlVersion!,
              treatmentBundle: cliOptions.treatmentBundle!,
              treatmentVersion: cliOptions.treatmentVersion!,
              controlWeight: cliOptions.controlWeight!,
              treatmentWeight: cliOptions.treatmentWeight!,
              onlineEval: cliOptions.onlineEval!,
              trafficHeaderName: cliOptions.trafficHeader,
              maxDurationDays: cliOptions.maxDuration,
              enableOnCreate: cliOptions.enable,
            });

            if (cliOptions.json) {
              console.log(JSON.stringify(serializeResult(result)));
            } else if (result.success) {
              console.log(`Added AB test '${result.abTestName}'`);
            } else {
              console.error(result.error.message);
            }
            process.exit(result.success ? 0 : 1);
          } else {
            // TUI fallback
            const [{ render }, { default: React }, { AddFlow }] = await Promise.all([
              import('ink'),
              import('react'),
              import('../tui/screens/add/AddFlow'),
            ]);
            const { clear, unmount } = render(
              React.createElement(AddFlow, {
                isInteractive: false,
                initialResource: 'ab-test',
                onExit: () => {
                  clear();
                  unmount();
                  process.exit(0);
                },
              })
            );
          }
        } catch (error) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
          } else {
            console.error(getErrorMessage(error));
          }
          process.exit(1);
        }
      }
    );

    removeCmd
      .command(this.kind)
      .description(`Remove ${this.article} ${this.label.toLowerCase()} from the project`)
      .option('--name <name>', 'Name of resource to remove [non-interactive]')
      .option('-y, --yes', 'Skip confirmation prompt [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .option('--delete-gateway', 'Also remove gateway targets and orphaned gateways (default: false)')
      .action(async (cliOptions: { name?: string; yes?: boolean; json?: boolean; deleteGateway?: boolean }) => {
        try {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          if (cliOptions.name || cliOptions.yes || cliOptions.json) {
            if (!cliOptions.name) {
              console.log(JSON.stringify({ success: false, error: '--name is required' }));
              process.exit(1);
            }

            const result = await withCommandRunTelemetry('remove.ab-test', {}, () =>
              this.remove(cliOptions.name!, { deleteGateway: cliOptions.deleteGateway })
            );
            console.log(
              JSON.stringify({
                success: result.success,
                resourceType: this.kind,
                resourceName: cliOptions.name,
                message: result.success ? `Removed ${this.label.toLowerCase()} '${cliOptions.name}'` : undefined,
                error: !result.success ? result.error.message : undefined,
              })
            );
            process.exit(result.success ? 0 : 1);
          } else {
            // TUI fallback
            requireTTY();
            const [{ render }, { default: React }, { RemoveFlow }] = await Promise.all([
              import('ink'),
              import('react'),
              import('../tui/screens/remove'),
            ]);
            const { clear, unmount } = render(
              React.createElement(RemoveFlow, {
                isInteractive: false,
                force: cliOptions.yes,
                initialResourceType: this.kind,
                initialResourceName: cliOptions.name,
                onExit: () => {
                  clear();
                  unmount();
                  process.exit(0);
                },
              })
            );
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

  addScreen(): AddScreenComponent {
    return null;
  }

  private async createABTest(options: AddABTestOptions): Promise<ABTest> {
    const project = await this.readProjectSpec();

    this.checkDuplicate(project.abTests ?? [], options.name);

    // Resolve gateway reference based on the user's choice
    let gatewayRef: string;
    const choice = options.gatewayChoice ?? { type: 'create-new' };

    if (choice.type === 'existing-http') {
      // Reuse an existing HTTP gateway from the project spec
      const existing = (project.httpGateways ?? []).find(gw => gw.name === choice.name);
      if (!existing) {
        throw new Error(`HTTP gateway "${choice.name}" not found in project.`);
      }
      gatewayRef = `{{gateway:${choice.name}}}`;
    } else {
      // Create new HTTP gateway — truncate name to fit 48-char limit
      const httpGwName = `${options.name.replace(/_/g, '-').slice(0, 44)}-gw`;
      const existingGw = (project.httpGateways ?? []).find(gw => gw.name === httpGwName);
      if (existingGw) {
        if (existingGw.runtimeRef !== options.agent) {
          throw new Error(
            `HTTP gateway "${httpGwName}" already exists with a different runtime (${existingGw.runtimeRef}). ` +
              `Choose a different AB test name to avoid a gateway name collision.`
          );
        }
      } else {
        project.httpGateways ??= [];
        project.httpGateways.push({
          name: httpGwName,
          runtimeRef: options.agent,
        });
      }
      gatewayRef = `{{gateway:${httpGwName}}}`;
    }

    const abTest: ABTest = {
      name: options.name,
      mode: 'config-bundle',
      ...(options.description && { description: options.description }),
      gatewayRef,
      ...(options.roleArn && { roleArn: options.roleArn }),
      variants: [
        {
          name: 'C',
          weight: options.controlWeight,
          variantConfiguration: {
            configurationBundle: {
              bundleArn: options.controlBundle,
              bundleVersion: options.controlVersion,
            },
          },
        },
        {
          name: 'T1',
          weight: options.treatmentWeight,
          variantConfiguration: {
            configurationBundle: {
              bundleArn: options.treatmentBundle,
              bundleVersion: options.treatmentVersion,
            },
          },
        },
      ],
      evaluationConfig: {
        onlineEvaluationConfigArn: options.onlineEval,
      },
      ...(options.trafficHeaderName && {
        trafficAllocationConfig: { routeOnHeader: { headerName: options.trafficHeaderName } },
      }),
      ...(options.maxDurationDays !== undefined && { maxDurationDays: options.maxDurationDays }),
      ...(options.enableOnCreate !== undefined && { enableOnCreate: options.enableOnCreate }),
    };

    project.abTests ??= [];
    project.abTests.push(abTest);
    await this.writeProjectSpec(project);

    return abTest;
  }

  async addTargetBased(options: AddTargetBasedABTestOptions): Promise<AddResult<{ abTestName: string }>> {
    try {
      const abTest = await this.createTargetBasedABTest(options);
      return { success: true, abTestName: abTest.name };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  private async createTargetBasedABTest(options: AddTargetBasedABTestOptions): Promise<ABTest> {
    const project = await this.readProjectSpec();

    this.checkDuplicate(project.abTests ?? [], options.name);

    // Validate runtime exists
    const runtime = project.runtimes.find(r => r.name === options.runtime);
    if (!runtime) {
      throw new Error(`Runtime "${options.runtime}" not found in project.`);
    }

    // Validate endpoints exist on the runtime
    if (!runtime.endpoints?.[options.controlEndpoint]) {
      throw new Error(
        `Endpoint "${options.controlEndpoint}" not found on runtime "${options.runtime}". Add it with: agentcore add runtime-endpoint`
      );
    }
    if (!runtime.endpoints?.[options.treatmentEndpoint]) {
      throw new Error(
        `Endpoint "${options.treatmentEndpoint}" not found on runtime "${options.runtime}". Add it with: agentcore add runtime-endpoint`
      );
    }

    // Auto-generate target names from runtime + qualifier
    const controlTarget = `${options.runtime}-${options.controlEndpoint}`;
    const treatmentTarget = `${options.runtime}-${options.treatmentEndpoint}`;

    // Auto-create HTTP gateway if it doesn't exist
    let existing = (project.httpGateways ?? []).find(gw => gw.name === options.gateway);
    if (!existing) {
      existing = {
        name: options.gateway,
        description: `HTTP gateway for AB test ${options.name}`,
        runtimeRef: options.runtime,
        targets: [
          { name: controlTarget, runtimeRef: options.runtime, qualifier: options.controlEndpoint },
          { name: treatmentTarget, runtimeRef: options.runtime, qualifier: options.treatmentEndpoint },
        ],
      };
      project.httpGateways ??= [];
      project.httpGateways.push(existing);
    } else {
      // Gateway exists — ensure targets exist
      existing.targets ??= [];
      if (!existing.targets.find(t => t.name === controlTarget)) {
        existing.targets.push({
          name: controlTarget,
          runtimeRef: options.runtime,
          qualifier: options.controlEndpoint,
        });
      }
      if (!existing.targets.find(t => t.name === treatmentTarget)) {
        existing.targets.push({
          name: treatmentTarget,
          runtimeRef: options.runtime,
          qualifier: options.treatmentEndpoint,
        });
      }
    }
    const gatewayRef = `{{gateway:${options.gateway}}}`;

    // Look up online eval configs by name
    const controlEvalConfig = project.onlineEvalConfigs.find(c => c.name === options.controlOnlineEval);
    if (!controlEvalConfig) {
      throw new Error(
        `Online eval config '${options.controlOnlineEval}' not found. Create it first with: agentcore add online-eval`
      );
    }
    const treatmentEvalConfig = project.onlineEvalConfigs.find(c => c.name === options.treatmentOnlineEval);
    if (!treatmentEvalConfig) {
      throw new Error(
        `Online eval config '${options.treatmentOnlineEval}' not found. Create it first with: agentcore add online-eval`
      );
    }

    // Store eval names — post-deploy resolveOnlineEvalArn will resolve names to ARNs
    const evaluationConfig: ABTest['evaluationConfig'] = {
      perVariantOnlineEvaluationConfig: [
        { treatmentName: 'C' as const, onlineEvaluationConfigArn: options.controlOnlineEval },
        { treatmentName: 'T1' as const, onlineEvaluationConfigArn: options.treatmentOnlineEval },
      ],
    };

    const abTest: ABTest = {
      name: options.name,
      mode: 'target-based',
      ...(options.description && { description: options.description }),
      gatewayRef,
      ...(options.roleArn && { roleArn: options.roleArn }),
      variants: [
        {
          name: 'C' as const,
          weight: options.controlWeight,
          variantConfiguration: {
            target: { targetName: controlTarget },
          },
        },
        {
          name: 'T1' as const,
          weight: options.treatmentWeight,
          variantConfiguration: {
            target: { targetName: treatmentTarget },
          },
        },
      ],
      evaluationConfig,
      ...(options.gatewayFilter && {
        gatewayFilter: { targetPaths: [options.gatewayFilter] },
      }),
      ...(options.enableOnCreate !== undefined && { enableOnCreate: options.enableOnCreate }),
    };

    project.abTests ??= [];
    project.abTests.push(abTest);
    await this.writeProjectSpec(project);

    return abTest;
  }
}
