import { findConfigRoot } from '../../lib';
import type { Result } from '../../lib/result';
import type { DatasetSchemaType } from '../../schema';
import { DatasetSchema } from '../../schema';
import type { AddDatasetOptions } from '../commands/add/types';
import { validateAddDatasetOptions } from '../commands/add/validate';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { runCliCommand } from '../telemetry/cli-command-run.js';
import { getTemplatePath } from '../templates/templateRoot';
import { requireTTY } from '../tui/guards/tty';
import { BasePrimitive } from './BasePrimitive';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SCHEMA_TYPE_TO_ASSET: Record<string, string> = {
  AGENTCORE_EVALUATION_PREDEFINED_V1: 'predefined-v1.jsonl',
  AGENTCORE_EVALUATION_SIMULATED_V1: 'simulated-v1.jsonl',
};

/**
 * Represents a dataset that can be removed.
 */
export type RemovableDataset = RemovableResource;

/**
 * DatasetPrimitive handles all dataset add/remove operations.
 */
export class DatasetPrimitive extends BasePrimitive<AddDatasetOptions, RemovableDataset> {
  readonly kind = 'dataset';
  readonly label = 'Dataset';
  readonly primitiveSchema = DatasetSchema;

  async add(options: AddDatasetOptions): Promise<AddResult<{ datasetName: string; location: string }>> {
    try {
      const project = await this.readProjectSpec();
      const datasets = project.datasets ?? [];

      this.checkDuplicate(datasets, options.name);

      const location = `datasets/${options.name}.jsonl`;
      const dataset = {
        name: options.name,
        schemaType: options.schemaType,
        ...(options.description && { description: options.description }),
        config: {
          managed: { location },
        },
      };

      datasets.push(dataset);
      project.datasets = datasets;
      await this.writeProjectSpec(project);

      // Scaffold the starter .jsonl file
      await this.scaffoldDatasetFile(options.name, options.schemaType, location);

      return { success: true, datasetName: dataset.name, location: `agentcore/${location}` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err : new Error(getErrorMessage(err)) };
    }
  }

  async remove(datasetName: string): Promise<Result> {
    try {
      const project = await this.readProjectSpec();
      const datasets = project.datasets ?? [];

      const datasetIndex = datasets.findIndex(d => d.name === datasetName);
      if (datasetIndex === -1) {
        return { success: false, error: new Error(`Dataset "${datasetName}" not found.`) };
      }

      datasets.splice(datasetIndex, 1);
      project.datasets = datasets;
      await this.writeProjectSpec(project);

      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err : new Error('Unknown error') };
    }
  }

  async previewRemove(datasetName: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();
    const datasets = project.datasets ?? [];

    const dataset = datasets.find(d => d.name === datasetName);
    if (!dataset) {
      throw new Error(`Dataset "${datasetName}" not found.`);
    }

    const summary: string[] = [`Removing dataset: ${datasetName}`];
    const schemaChanges: SchemaChange[] = [];

    const afterSpec = {
      ...project,
      datasets: datasets.filter(d => d.name !== datasetName),
    };

    schemaChanges.push({
      file: 'agentcore/agentcore.json',
      before: project,
      after: afterSpec,
    });

    return { summary, directoriesToDelete: [], schemaChanges };
  }

  async getRemovable(): Promise<RemovableDataset[]> {
    try {
      const project = await this.readProjectSpec();
      return (project.datasets ?? []).map(d => ({ name: d.name }));
    } catch {
      return [];
    }
  }

  /**
   * Get list of existing dataset names.
   */
  async getAllNames(): Promise<string[]> {
    try {
      const project = await this.configIO.readProjectSpec();
      return (project.datasets ?? []).map(d => d.name);
    } catch {
      return [];
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('dataset')
      .description('Add a dataset to the project')
      .option('--name <name>', 'Dataset name [non-interactive]')
      .option(
        '--schema-type <schemaType>',
        'Dataset schema type: AGENTCORE_EVALUATION_PREDEFINED_V1 | AGENTCORE_EVALUATION_SIMULATED_V1 [non-interactive]'
      )
      .option('--description <description>', 'Dataset description [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(async (cliOptions: { name?: string; schemaType?: string; description?: string; json?: boolean }) => {
        if (!findConfigRoot()) {
          console.error('No agentcore project found. Run `agentcore create` first.');
          process.exit(1);
        }

        if (cliOptions.name || cliOptions.json) {
          // CLI mode
          await runCliCommand('add.dataset', !!cliOptions.json, async () => {
            const validation = validateAddDatasetOptions({
              name: cliOptions.name ?? '',
              schemaType: (cliOptions.schemaType ?? '') as DatasetSchemaType,
              description: cliOptions.description,
            });

            if (!validation.valid) {
              throw new Error(validation.error);
            }

            const result = await this.add({
              name: cliOptions.name!,
              schemaType: cliOptions.schemaType! as DatasetSchemaType,
              description: cliOptions.description,
            });

            if (!result.success) {
              throw result.error;
            }

            if (cliOptions.json) {
              console.log(JSON.stringify(result));
            } else {
              console.log(`Added dataset '${result.datasetName}'`);
              console.log(`  File: ${result.location}`);
            }

            return {};
          });
        } else {
          try {
            // TUI fallback — dynamic imports to avoid pulling ink (async) into registry
            requireTTY();
            const [{ render }, { default: React }, { AddFlow }] = await Promise.all([
              import('ink'),
              import('react'),
              import('../tui/screens/add/AddFlow'),
            ]);
            const { unmount } = render(
              React.createElement(AddFlow, {
                isInteractive: false,
                initialResource: 'dataset',
                onExit: () => {
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
      });

    this.registerRemoveSubcommand(removeCmd);
  }

  addScreen(): AddScreenComponent {
    return null;
  }

  /**
   * Copy the starter JSONL asset file to the dataset location.
   */
  private async scaffoldDatasetFile(name: string, schemaType: string, location: string): Promise<void> {
    const configRoot = findConfigRoot();
    if (!configRoot) return;

    const targetPath = join(configRoot, location);
    const targetDir = join(configRoot, 'datasets');
    await mkdir(targetDir, { recursive: true });

    const assetFile = SCHEMA_TYPE_TO_ASSET[schemaType];
    if (!assetFile) return;

    const sourcePath = getTemplatePath('datasets', assetFile);
    await copyFile(sourcePath, targetPath);
  }
}
