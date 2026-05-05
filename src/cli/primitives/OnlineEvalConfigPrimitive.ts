import { ResourceNotFoundError, findConfigRoot, serializeResult, toError } from '../../lib';
import type { Result } from '../../lib/result';
import type { OnlineEvalConfig } from '../../schema';
import { OnlineEvalConfigSchema } from '../../schema';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { runCliCommand } from '../telemetry/cli-command-run.js';
import { requireTTY } from '../tui/guards/tty';
import { BasePrimitive } from './BasePrimitive';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';

export interface AddOnlineEvalConfigOptions {
  name: string;
  agent: string;
  evaluators: string[];
  samplingRate: number;
  enableOnCreate?: boolean;
  endpoint?: string;
}

export type RemovableOnlineEvalConfig = RemovableResource;

/**
 * OnlineEvalConfigPrimitive handles all online eval config add/remove operations.
 */
export class OnlineEvalConfigPrimitive extends BasePrimitive<AddOnlineEvalConfigOptions, RemovableOnlineEvalConfig> {
  readonly kind = 'online-eval' as const;
  readonly label = 'Online Eval Config';
  override readonly article = 'an';
  readonly primitiveSchema = OnlineEvalConfigSchema;

  async add(options: AddOnlineEvalConfigOptions): Promise<AddResult<{ configName: string }>> {
    try {
      const config = await this.createOnlineEvalConfig(options);
      return { success: true, configName: config.name };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async remove(configName: string): Promise<Result> {
    try {
      const project = await this.readProjectSpec();

      const index = project.onlineEvalConfigs.findIndex(c => c.name === configName);
      if (index === -1) {
        return { success: false, error: new ResourceNotFoundError(`Online eval config "${configName}" not found.`) };
      }

      project.onlineEvalConfigs.splice(index, 1);
      await this.writeProjectSpec(project);

      return { success: true };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async previewRemove(configName: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();

    const config = project.onlineEvalConfigs.find(c => c.name === configName);
    if (!config) {
      throw new Error(`Online eval config "${configName}" not found.`);
    }

    const summary: string[] = [
      `Removing online eval config: ${configName}`,
      `Uses evaluators: ${config.evaluators.join(', ')}`,
    ];
    const schemaChanges: SchemaChange[] = [];

    const afterSpec = {
      ...project,
      onlineEvalConfigs: project.onlineEvalConfigs.filter(c => c.name !== configName),
    };

    schemaChanges.push({
      file: 'agentcore/agentcore.json',
      before: project,
      after: afterSpec,
    });

    return { summary, directoriesToDelete: [], schemaChanges };
  }

  async getRemovable(): Promise<RemovableOnlineEvalConfig[]> {
    try {
      const project = await this.readProjectSpec();
      return project.onlineEvalConfigs.map(c => ({ name: c.name }));
    } catch {
      return [];
    }
  }

  async getAllNames(): Promise<string[]> {
    try {
      const project = await this.readProjectSpec();
      return project.onlineEvalConfigs.map(c => c.name);
    } catch {
      return [];
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('online-eval')
      .description('Add an online eval config to the project')
      .option('--name <name>', 'Config name [non-interactive]')
      .option('-r, --runtime <name>', 'Runtime to monitor [non-interactive]')
      .option('-e, --evaluator <evaluators...>', 'Evaluator name(s), Builtin.* IDs, or ARNs [non-interactive]')
      .option('--evaluator-arn <arns...>', 'Evaluator ARN(s) [non-interactive]')
      .option('--sampling-rate <rate>', 'Sampling percentage (0.01-100) [non-interactive]')
      .option('--endpoint <name>', 'Runtime endpoint name to scope monitoring [non-interactive]')
      .option('--enable-on-create', 'Enable evaluation immediately after deploy [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(
        async (cliOptions: {
          name?: string;
          runtime?: string;
          evaluator?: string[];
          evaluatorArn?: string[];
          samplingRate?: string;
          endpoint?: string;
          enableOnCreate?: boolean;
          json?: boolean;
        }) => {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          if (cliOptions.name || cliOptions.json) {
            // Merge --evaluator and --evaluator-arn into a single list
            const allEvaluators = [...(cliOptions.evaluator ?? []), ...(cliOptions.evaluatorArn ?? [])];

            await runCliCommand('add.online-eval', !!cliOptions.json, async () => {
              if (!cliOptions.name || !cliOptions.runtime || allEvaluators.length === 0 || !cliOptions.samplingRate) {
                throw new Error(
                  '--name, --runtime, --evaluator (and/or --evaluator-arn), and --sampling-rate are all required in non-interactive mode'
                );
              }

              // Sampling rate as a percentage of requests to evaluate (0.01% to 100%)
              const samplingRate = parseFloat(cliOptions.samplingRate);
              if (isNaN(samplingRate) || samplingRate < 0.01 || samplingRate > 100) {
                throw new Error(
                  `Invalid --sampling-rate "${cliOptions.samplingRate}". Must be a percentage between 0.01 and 100`
                );
              }

              const result = await this.add({
                name: cliOptions.name,
                agent: cliOptions.runtime,
                evaluators: allEvaluators,
                samplingRate,
                enableOnCreate: cliOptions.enableOnCreate,
                endpoint: cliOptions.endpoint,
              });

              if (!result.success) {
                throw result.error;
              }

              if (cliOptions.json) {
                console.log(JSON.stringify(serializeResult(result)));
              } else {
                console.log(`Added online eval config '${result.configName}'`);
              }

              return {
                evaluator_count: allEvaluators.length,
                enable_on_create: cliOptions.enableOnCreate ?? false,
              };
            });
          } else {
            try {
              // TUI fallback
              requireTTY();
              const [{ render }, { default: React }, { AddFlow }] = await Promise.all([
                import('ink'),
                import('react'),
                import('../tui/screens/add/AddFlow'),
              ]);
              const { clear, unmount } = render(
                React.createElement(AddFlow, {
                  isInteractive: false,
                  initialResource: 'online-eval',
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

    this.registerRemoveSubcommand(removeCmd);
  }

  addScreen(): AddScreenComponent {
    return null;
  }

  private async createOnlineEvalConfig(options: AddOnlineEvalConfigOptions): Promise<OnlineEvalConfig> {
    const project = await this.readProjectSpec();

    this.checkDuplicate(project.onlineEvalConfigs, options.name, 'Online eval config');

    // Validate that the endpoint exists on the specified runtime if provided
    if (options.endpoint) {
      const runtime = project.runtimes.find(r => r.name === options.agent);
      if (!runtime) {
        throw new Error(`Runtime "${options.agent}" not found in project.`);
      }
      if (!runtime.endpoints?.[options.endpoint]) {
        throw new Error(
          `Endpoint "${options.endpoint}" not found on runtime "${options.agent}". Available endpoints: ${
            runtime.endpoints ? Object.keys(runtime.endpoints).join(', ') : '(none)'
          }`
        );
      }
    }

    const config: OnlineEvalConfig = {
      name: options.name,
      agent: options.agent,
      evaluators: options.evaluators,
      samplingRate: options.samplingRate,
      ...(options.enableOnCreate !== undefined && { enableOnCreate: options.enableOnCreate }),
      ...(options.endpoint && { endpoint: options.endpoint }),
    };

    project.onlineEvalConfigs.push(config);
    await this.writeProjectSpec(project);

    return config;
  }
}
