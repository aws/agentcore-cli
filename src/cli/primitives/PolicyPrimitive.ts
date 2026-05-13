import { ResourceNotFoundError, ValidationError, findConfigRoot, serializeResult, toError } from '../../lib';
import type { Result } from '../../lib/result';
import type { Policy } from '../../schema';
import { PolicySchema, ValidationModeSchema } from '../../schema';
import { detectRegion } from '../aws';
import { getPolicyGeneration, startPolicyGeneration } from '../aws/policy-generation';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { runCliCommand, withCommandRunTelemetry } from '../telemetry/cli-command-run.js';
import { ValidationMode, standardize } from '../telemetry/schemas/common-shapes.js';
import { requireTTY } from '../tui/guards/tty';
import { BasePrimitive } from './BasePrimitive';
import { SOURCE_CODE_NOTE } from './constants';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';
import { existsSync, readFileSync } from 'fs';

export interface AddPolicyOptions {
  name: string;
  engine: string;
  description?: string;
  statement?: string;
  source?: string;
  generate?: string;
  gateway?: string;
  validationMode?: 'FAIL_ON_ANY_FINDINGS' | 'IGNORE_ALL_FINDINGS';
}

export interface RemovablePolicyResource extends RemovableResource {
  engineName: string;
}

export class PolicyPrimitive extends BasePrimitive<AddPolicyOptions, RemovablePolicyResource> {
  readonly kind = 'policy' as const;
  readonly label = 'Policy';
  readonly primitiveSchema = PolicySchema;

  async add(options: AddPolicyOptions): Promise<AddResult<{ policyName: string; engineName: string }>> {
    try {
      const sourceFlags = [options.statement, options.source, options.generate].filter(Boolean);
      if (sourceFlags.length > 1) {
        return {
          success: false,
          error: new ValidationError('Only one of --statement, --source, or --generate can be provided.'),
        };
      }

      const project = await this.readProjectSpec();

      const engine = project.policyEngines.find(e => e.name === options.engine);
      if (!engine) {
        return { success: false, error: new ResourceNotFoundError(`Policy engine "${options.engine}" not found.`) };
      }

      this.checkDuplicate(engine.policies, options.name, 'Policy');

      let statement = options.statement ?? '';

      if (options.source && !statement) {
        if (!existsSync(options.source)) {
          return { success: false, error: new ResourceNotFoundError(`Source file not found: ${options.source}`) };
        }
        statement = readFileSync(options.source, 'utf-8').trim();
        if (!statement) {
          return { success: false, error: new ValidationError(`Source file is empty: ${options.source}`) };
        }
      }

      if (options.generate && !statement) {
        const deployedState = await this.configIO.readDeployedState();
        let engineId: string | undefined;
        let gatewayArn: string | undefined;

        for (const target of Object.values(deployedState.targets)) {
          engineId ??= target.resources?.policyEngines?.[options.engine]?.policyEngineId;
          const gateways = target.resources?.mcp?.gateways;
          if (gateways) {
            if (options.gateway) {
              const gw = gateways[options.gateway];
              if (gw?.gatewayArn) {
                gatewayArn = gw.gatewayArn;
              }
            } else if (!gatewayArn) {
              const firstGateway = Object.values(gateways)[0];
              if (firstGateway?.gatewayArn) {
                gatewayArn = firstGateway.gatewayArn;
              }
            }
          }
        }

        if (!engineId) {
          return {
            success: false,
            error: new ValidationError(
              `Policy engine "${options.engine}" is not deployed. Run \`agentcore deploy\` first.`
            ),
          };
        }
        if (options.gateway && !gatewayArn) {
          return {
            success: false,
            error: new ResourceNotFoundError(`Gateway "${options.gateway}" not found in deployed state.`),
          };
        }
        if (!gatewayArn) {
          return {
            success: false,
            error: new ResourceNotFoundError(
              'No deployed gateway found. Policy generation requires a deployed gateway. Use --gateway <name> to specify one.'
            ),
          };
        }

        const { region } = await detectRegion();
        const startResult = await startPolicyGeneration({
          policyEngineId: engineId,
          description: options.generate,
          region,
          resourceArn: gatewayArn,
        });

        const genResult = await getPolicyGeneration({
          generationId: startResult.generationId,
          policyEngineId: engineId,
          region,
        });

        statement = genResult.statement;
      }

      if (!statement) {
        return {
          success: false,
          error: new ValidationError('Either --statement, --source, or --generate is required.'),
        };
      }

      const policy: Policy = {
        name: options.name,
        ...(options.description && { description: options.description }),
        statement,
        ...(options.source && { sourceFile: options.source }),
        validationMode: options.validationMode ?? 'FAIL_ON_ANY_FINDINGS',
      };

      engine.policies.push(policy);
      await this.writeProjectSpec(project);

      return { success: true, policyName: policy.name, engineName: options.engine };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  /**
   * Remove a policy by composite key "engineName/policyName" or by separate name + engineName.
   * The composite key format is used by getRemovable() and the generic TUI remove flow.
   * The separate arguments form is used by the CLI --name + --engine flags.
   */
  async remove(nameOrCompositeKey: string, engineName?: string): Promise<Result> {
    try {
      const project = await this.readProjectSpec();

      // Parse composite key if engineName not provided separately
      let resolvedEngine: string | undefined = engineName;
      let resolvedPolicy: string = nameOrCompositeKey;

      if (!resolvedEngine && nameOrCompositeKey.includes('/')) {
        const slashIndex = nameOrCompositeKey.indexOf('/');
        resolvedEngine = nameOrCompositeKey.slice(0, slashIndex);
        resolvedPolicy = nameOrCompositeKey.slice(slashIndex + 1);
      }

      if (!resolvedEngine) {
        const matchingEngines = project.policyEngines.filter(e => e.policies.some(p => p.name === resolvedPolicy));
        if (matchingEngines.length > 1) {
          return {
            success: false,
            error: new ValidationError(
              `Policy "${resolvedPolicy}" exists in multiple engines: ${matchingEngines.map(e => e.name).join(', ')}. Use --engine to specify which one.`
            ),
          };
        }
      }

      for (const engine of project.policyEngines) {
        if (resolvedEngine && engine.name !== resolvedEngine) continue;

        const policyIndex = engine.policies.findIndex(p => p.name === resolvedPolicy);
        if (policyIndex !== -1) {
          engine.policies.splice(policyIndex, 1);
          await this.writeProjectSpec(project);
          return { success: true };
        }
      }

      return {
        success: false,
        error: new ResourceNotFoundError(
          `Policy "${resolvedPolicy}" not found${resolvedEngine ? ` in engine "${resolvedEngine}"` : ''}.`
        ),
      };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async previewRemove(nameOrCompositeKey: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();

    // Parse composite key "engineName/policyName"
    let targetEngine: string | undefined;
    let targetPolicy: string = nameOrCompositeKey;

    if (nameOrCompositeKey.includes('/')) {
      const slashIndex = nameOrCompositeKey.indexOf('/');
      targetEngine = nameOrCompositeKey.slice(0, slashIndex);
      targetPolicy = nameOrCompositeKey.slice(slashIndex + 1);
    }

    if (!targetEngine) {
      const matchingEngines = project.policyEngines.filter(e => e.policies.some(p => p.name === targetPolicy));
      if (matchingEngines.length > 1) {
        throw new Error(
          `Policy "${targetPolicy}" exists in multiple engines: ${matchingEngines.map(e => e.name).join(', ')}. Use --engine to specify which one.`
        );
      }
    }

    for (const engine of project.policyEngines) {
      if (targetEngine && engine.name !== targetEngine) continue;

      const policy = engine.policies.find(p => p.name === targetPolicy);
      if (policy) {
        const summary = [`Removing policy: ${targetPolicy} (from engine ${engine.name})`];
        const schemaChanges: SchemaChange[] = [];

        const afterSpec = {
          ...project,
          policyEngines: project.policyEngines.map(e => {
            if (e.name !== engine.name) return e;
            return {
              ...e,
              policies: e.policies.filter(p => p.name !== targetPolicy),
            };
          }),
        };
        schemaChanges.push({
          file: 'agentcore/agentcore.json',
          before: project,
          after: afterSpec,
        });

        return { summary, directoriesToDelete: [], schemaChanges };
      }
    }

    throw new Error(`Policy "${targetPolicy}" not found${targetEngine ? ` in engine "${targetEngine}"` : ''}.`);
  }

  async getRemovable(): Promise<RemovablePolicyResource[]> {
    try {
      const project = await this.readProjectSpec();
      const resources: RemovablePolicyResource[] = [];

      for (const engine of project.policyEngines) {
        for (const policy of engine.policies) {
          resources.push({
            name: `${engine.name}/${policy.name}`,
            engineName: engine.name,
          });
        }
      }

      return resources;
    } catch {
      return [];
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('policy')
      .description('Add a policy to a policy engine')
      .option('--name <name>', 'Policy name [non-interactive]')
      .option('--engine <engine>', 'Policy engine name [non-interactive]')
      .option('--description <desc>', 'Policy description [non-interactive]')
      .option('--source <path>', 'Path to a Cedar policy file [non-interactive]')
      .option('--statement <cedar>', 'Cedar policy statement [non-interactive]')
      .option('-g, --generate <prompt>', 'Generate Cedar policy from natural language description [non-interactive]')
      .option('--gateway <name>', 'Deployed gateway name for policy generation [non-interactive]')
      .option(
        '--validation-mode <mode>',
        'Validation mode: FAIL_ON_ANY_FINDINGS or IGNORE_ALL_FINDINGS [non-interactive]'
      )
      .option('--json', 'Output as JSON [non-interactive]')
      .action(
        async (cliOptions: {
          name?: string;
          engine?: string;
          description?: string;
          source?: string;
          statement?: string;
          generate?: string;
          gateway?: string;
          validationMode?: string;
          json?: boolean;
        }) => {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          if (
            cliOptions.name ||
            cliOptions.engine ||
            cliOptions.source ||
            cliOptions.statement ||
            cliOptions.generate ||
            cliOptions.json
          ) {
            await runCliCommand('add.policy', !!cliOptions.json, async () => {
              if (!cliOptions.name) {
                throw new Error('--name is required');
              }
              if (!cliOptions.engine) {
                throw new Error('--engine is required');
              }

              const result = await this.add({
                name: cliOptions.name,
                engine: cliOptions.engine,
                description: cliOptions.description,
                source: cliOptions.source,
                statement: cliOptions.statement,
                generate: cliOptions.generate,
                gateway: cliOptions.gateway,
                validationMode: cliOptions.validationMode
                  ? ValidationModeSchema.parse(cliOptions.validationMode)
                  : undefined,
              });

              if (!result.success) {
                throw result.error;
              }

              if (cliOptions.json) {
                console.log(JSON.stringify(serializeResult(result)));
              } else {
                console.log(`Added policy '${result.policyName}' to engine '${result.engineName}'`);
              }

              const sourceType: 'file' | 'statement' | 'generate' = cliOptions.source
                ? 'file'
                : cliOptions.generate
                  ? 'generate'
                  : 'statement';
              return {
                source_type: sourceType,
                validation_mode: standardize(ValidationMode, cliOptions.validationMode ?? 'FAIL_ON_ANY_FINDINGS'),
              };
            });
          } else {
            try {
              requireTTY();
              const [{ render }, { default: React }, { AddFlow }] = await Promise.all([
                import('ink'),
                import('react'),
                import('../tui/screens/add/AddFlow'),
              ]);
              const { clear, unmount } = render(
                React.createElement(AddFlow, {
                  isInteractive: false,
                  initialResource: 'policy',
                  onExit: () => {
                    clear();
                    unmount();
                    process.exit(0);
                  },
                })
              );
            } catch (error) {
              console.error(getErrorMessage(error));
              process.exit(1);
            }
          }
        }
      );

    removeCmd
      .command('policy')
      .description('Remove a policy from a policy engine')
      .option('--name <name>', 'Name of policy to remove [non-interactive]')
      .option('--engine <engine>', 'Policy engine name [non-interactive]')
      .option('-y, --yes', 'Skip confirmation prompt [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(async (cliOptions: { name?: string; engine?: string; yes?: boolean; json?: boolean }) => {
        try {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          if (cliOptions.name || cliOptions.yes || cliOptions.json) {
            if (!cliOptions.name) {
              if (cliOptions.json) {
                console.log(JSON.stringify({ success: false, error: '--name is required' }));
              } else {
                console.error('--name is required');
              }
              process.exit(1);
            }

            // Build composite key when --engine is provided for unambiguous removal
            const removeKey = cliOptions.engine ? `${cliOptions.engine}/${cliOptions.name}` : cliOptions.name;
            const result = await withCommandRunTelemetry('remove.policy', {}, () => this.remove(removeKey));

            if (cliOptions.json) {
              console.log(
                JSON.stringify({
                  success: result.success,
                  resourceType: this.kind,
                  resourceName: cliOptions.name,
                  message: result.success ? `Removed policy '${cliOptions.name}'` : undefined,
                  note: result.success ? SOURCE_CODE_NOTE : undefined,
                  error: !result.success ? result.error.message : undefined,
                })
              );
            } else if (result.success) {
              console.log(`Removed policy '${cliOptions.name}'`);
            } else {
              console.error(result.error.message);
            }
            process.exit(result.success ? 0 : 1);
          } else {
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
}
