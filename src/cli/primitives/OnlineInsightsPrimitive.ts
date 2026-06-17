import { ResourceNotFoundError, ValidationError, findConfigRoot, serializeResult, toError } from '../../lib';
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

export interface AddOnlineInsightsOptions {
  name: string;
  agent: string;
  insights: string[];
  samplingRate: number;
  clusteringFrequencies?: string[];
  enableOnCreate?: boolean;
  endpoint?: string;
}

export type RemovableOnlineInsightsConfig = RemovableResource;

/**
 * OnlineInsightsPrimitive handles add/remove operations for online insights configs.
 * These are online eval configs that use insights (not evaluators).
 */
export class OnlineInsightsPrimitive extends BasePrimitive<AddOnlineInsightsOptions, RemovableOnlineInsightsConfig> {
  readonly kind = 'online-insights' as const;
  readonly label = 'Online Insights Config';
  override readonly article = 'an';
  readonly primitiveSchema = OnlineEvalConfigSchema;

  async add(options: AddOnlineInsightsOptions): Promise<AddResult<{ configName: string }>> {
    try {
      const config = await this.createOnlineInsightsConfig(options);
      return { success: true, configName: config.name };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async remove(configName: string): Promise<Result> {
    try {
      const project = await this.readProjectSpec();

      const index = project.onlineEvalConfigs.findIndex(
        c => c.name === configName && c.insights && c.insights.length > 0
      );
      if (index === -1) {
        return {
          success: false,
          error: new ResourceNotFoundError(`Online insights config "${configName}" not found.`),
        };
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

    const config = project.onlineEvalConfigs.find(c => c.name === configName && c.insights && c.insights.length > 0);
    if (!config) {
      throw new Error(`Online insights config "${configName}" not found.`);
    }

    const summary: string[] = [
      `Removing online insights config: ${configName}`,
      `Uses insights: ${(config.insights ?? []).join(', ')}`,
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

  async getRemovable(): Promise<RemovableOnlineInsightsConfig[]> {
    try {
      const project = await this.readProjectSpec();
      return project.onlineEvalConfigs.filter(c => c.insights && c.insights.length > 0).map(c => ({ name: c.name }));
    } catch {
      return [];
    }
  }

  async getAllNames(): Promise<string[]> {
    try {
      const project = await this.readProjectSpec();
      return project.onlineEvalConfigs.filter(c => c.insights && c.insights.length > 0).map(c => c.name);
    } catch {
      return [];
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('online-insights')
      .description('Add an online insights config to the project')
      .option('--name <name>', 'Config name [non-interactive]')
      .option('-r, --runtime <name>', 'Runtime to monitor [non-interactive]')
      .option('--insights <insights...>', 'Insight IDs (e.g. Builtin.Insight.FailureAnalysis) [non-interactive]')
      .option('--sampling-rate <rate>', 'Sampling percentage (0.01-100) [non-interactive]')
      .option(
        '--clustering-frequency <frequencies...>',
        'Clustering frequencies: DAILY, WEEKLY, MONTHLY [non-interactive]'
      )
      .option('--endpoint <name>', 'Runtime endpoint name to scope monitoring [non-interactive]')
      .option('--enable-on-create', 'Enable insights immediately after deploy [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(
        async (cliOptions: {
          name?: string;
          runtime?: string;
          insights?: string[];
          samplingRate?: string;
          clusteringFrequency?: string[];
          endpoint?: string;
          enableOnCreate?: boolean;
          json?: boolean;
        }) => {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          if (cliOptions.name || cliOptions.json) {
            await runCliCommand('add.online-insights', !!cliOptions.json, async () => {
              if (!cliOptions.name || !cliOptions.runtime || !cliOptions.insights?.length || !cliOptions.samplingRate) {
                throw new Error(
                  '--name, --runtime, --insights, and --sampling-rate are all required in non-interactive mode'
                );
              }

              const samplingRate = parseFloat(cliOptions.samplingRate);
              if (isNaN(samplingRate) || samplingRate < 0.01 || samplingRate > 100) {
                throw new Error(
                  `Invalid --sampling-rate "${cliOptions.samplingRate}". Must be a percentage between 0.01 and 100`
                );
              }

              const result = await this.add({
                name: cliOptions.name,
                agent: cliOptions.runtime,
                insights: cliOptions.insights,
                samplingRate,
                clusteringFrequencies: cliOptions.clusteringFrequency,
                enableOnCreate: cliOptions.enableOnCreate,
                endpoint: cliOptions.endpoint,
              });

              if (!result.success) {
                throw result.error;
              }

              if (cliOptions.json) {
                console.log(JSON.stringify(serializeResult(result)));
              } else {
                console.log(`Added online insights config '${result.configName}'`);
              }

              return {
                insights_count: cliOptions.insights.length,
                enable_on_create: cliOptions.enableOnCreate ?? false,
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
                  initialResource: 'online-insights',
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

  private async createOnlineInsightsConfig(options: AddOnlineInsightsOptions): Promise<OnlineEvalConfig> {
    const project = await this.readProjectSpec();

    this.checkDuplicate(project.onlineEvalConfigs, options.name, 'Online insights config');

    validateInsightIds(options.insights);

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
      insights: options.insights,
      samplingRate: options.samplingRate,
      ...(options.clusteringFrequencies?.length && {
        clusteringConfig: {
          frequencies: options.clusteringFrequencies as ('DAILY' | 'WEEKLY' | 'MONTHLY')[],
        },
      }),
      ...(options.enableOnCreate !== undefined && { enableOnCreate: options.enableOnCreate }),
      ...(options.endpoint && { endpoint: options.endpoint }),
    };

    project.onlineEvalConfigs.push(config);
    await this.writeProjectSpec(project);

    return config;
  }
}

/** Validates that each insight ID starts with `Builtin.Insight.` or is a full ARN. */
export function validateInsightIds(insights: string[]): void {
  for (const insight of insights) {
    if (!insight.startsWith('Builtin.Insight.') && !insight.startsWith('arn:')) {
      throw new ValidationError(
        `Invalid insight "${insight}". Must be a Builtin.Insight.* identifier (e.g. Builtin.Insight.FailureAnalysis) or a full ARN.`
      );
    }
  }
}
