import { findConfigRoot } from '../../lib';
import type { OnlineEvalConfig } from '../../schema';
import { OnlineEvalConfigSchema } from '../../schema';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, RemovalResult, SchemaChange } from '../operations/remove/types';
import { BasePrimitive } from './BasePrimitive';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';

export interface AddOnlineEvalConfigOptions {
  name: string;
  agent: string;
  evaluators: string[];
  samplingRate: number;
  enableOnCreate?: boolean;
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
      return { success: false, error: getErrorMessage(err) };
    }
  }

  async remove(configName: string): Promise<RemovalResult> {
    try {
      const project = await this.readProjectSpec();

      const index = project.onlineEvalConfigs.findIndex(c => c.name === configName);
      if (index === -1) {
        return { success: false, error: `Online eval config "${configName}" not found.` };
      }

      project.onlineEvalConfigs.splice(index, 1);
      await this.writeProjectSpec(project);

      return { success: true };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
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
      .option('--enable-on-create', 'Enable evaluation immediately after deploy [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(
        async (cliOptions: {
          name?: string;
          runtime?: string;
          evaluator?: string[];
          evaluatorArn?: string[];
          samplingRate?: string;
          enableOnCreate?: boolean;
          json?: boolean;
        }) => {
          try {
            if (!findConfigRoot()) {
              console.error('No agentcore project found. Run `agentcore create` first.');
              process.exit(1);
            }

            if (cliOptions.name || cliOptions.json) {
              // Merge --evaluator and --evaluator-arn into a single list
              const allEvaluators = [...(cliOptions.evaluator ?? []), ...(cliOptions.evaluatorArn ?? [])];

              if (!cliOptions.name || !cliOptions.runtime || allEvaluators.length === 0 || !cliOptions.samplingRate) {
                const error =
                  '--name, --runtime, --evaluator (and/or --evaluator-arn), and --sampling-rate are all required in non-interactive mode';
                if (cliOptions.json) {
                  console.log(JSON.stringify({ success: false, error }));
                } else {
                  console.error(error);
                }
                process.exit(1);
              }

              // Sampling rate as a percentage of requests to evaluate (0.01% to 100%)
              const samplingRate = parseFloat(cliOptions.samplingRate);
              if (isNaN(samplingRate) || samplingRate < 0.01 || samplingRate > 100) {
                const error = `Invalid --sampling-rate "${cliOptions.samplingRate}". Must be a percentage between 0.01 and 100`;
                if (cliOptions.json) {
                  console.log(JSON.stringify({ success: false, error }));
                } else {
                  console.error(error);
                }
                process.exit(1);
              }

              const result = await this.add({
                name: cliOptions.name,
                agent: cliOptions.runtime,
                evaluators: allEvaluators,
                samplingRate,
                enableOnCreate: cliOptions.enableOnCreate,
              });

              if (cliOptions.json) {
                console.log(JSON.stringify(result));
              } else if (result.success) {
                console.log(`Added online eval config '${result.configName}'`);
              } else {
                console.error(result.error);
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

    this.registerRemoveSubcommand(removeCmd);
  }

  addScreen(): AddScreenComponent {
    return null;
  }

  private async createOnlineEvalConfig(options: AddOnlineEvalConfigOptions): Promise<OnlineEvalConfig> {
    const project = await this.readProjectSpec();

    this.checkDuplicate(project.onlineEvalConfigs, options.name, 'Online eval config');

    const config: OnlineEvalConfig = {
      name: options.name,
      agent: options.agent,
      evaluators: options.evaluators,
      samplingRate: options.samplingRate,
      ...(options.enableOnCreate !== undefined && { enableOnCreate: options.enableOnCreate }),
    };

    project.onlineEvalConfigs.push(config);
    await this.writeProjectSpec(project);

    return config;
  }
}
