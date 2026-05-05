import { ResourceNotFoundError, findConfigRoot, serializeResult, toError } from '../../lib';
import type { Result } from '../../lib/result';
import type { ConfigBundle } from '../../schema';
import { ConfigBundleSchema } from '../../schema';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { BasePrimitive } from './BasePrimitive';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';
import { readFileSync } from 'fs';

export interface AddConfigBundleOptions {
  name: string;
  description?: string;
  components: Record<string, { configuration: Record<string, unknown> }>;
  branchName?: string;
  commitMessage?: string;
}

export type RemovableConfigBundle = RemovableResource;

/**
 * ConfigBundlePrimitive handles all configuration bundle add/remove operations.
 *
 * Configuration bundles are versioned collections of component configurations
 * (system prompts, tool configs) keyed by component ARN. They are created via
 * direct API calls (not CloudFormation) and stored in agentcore.json for
 * lifecycle management.
 */
export class ConfigBundlePrimitive extends BasePrimitive<AddConfigBundleOptions, RemovableConfigBundle> {
  readonly kind = 'config-bundle' as const;
  readonly label = 'Configuration Bundle';
  override readonly article = 'a';
  readonly primitiveSchema = ConfigBundleSchema;

  async add(options: AddConfigBundleOptions): Promise<AddResult<{ bundleName: string }>> {
    try {
      const bundle = await this.createConfigBundle(options);
      return { success: true, bundleName: bundle.name };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async remove(bundleName: string): Promise<Result> {
    try {
      const project = await this.readProjectSpec();

      const index = (project.configBundles ?? []).findIndex(b => b.name === bundleName);
      if (index === -1) {
        return { success: false, error: new ResourceNotFoundError(`Configuration bundle "${bundleName}" not found.`) };
      }

      project.configBundles.splice(index, 1);
      await this.writeProjectSpec(project);

      return { success: true };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async previewRemove(bundleName: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();

    const bundle = (project.configBundles ?? []).find(b => b.name === bundleName);
    if (!bundle) {
      throw new Error(`Configuration bundle "${bundleName}" not found.`);
    }

    const summary: string[] = [`Removing configuration bundle: ${bundleName}`];
    const schemaChanges: SchemaChange[] = [];

    const afterSpec = {
      ...project,
      configBundles: (project.configBundles ?? []).filter(b => b.name !== bundleName),
    };

    schemaChanges.push({
      file: 'agentcore/agentcore.json',
      before: project,
      after: afterSpec,
    });

    return { summary, directoriesToDelete: [], schemaChanges };
  }

  async getRemovable(): Promise<RemovableConfigBundle[]> {
    try {
      const project = await this.readProjectSpec();
      return (project.configBundles ?? []).map(b => ({ name: b.name }));
    } catch {
      return [];
    }
  }

  async getAllNames(): Promise<string[]> {
    try {
      const project = await this.readProjectSpec();
      return (project.configBundles ?? []).map(b => b.name);
    } catch {
      return [];
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command(this.kind)
      .description('[preview] Add a configuration bundle to the project')
      .option('--name <name>', 'Bundle name')
      .option('--description <text>', 'Bundle description')
      .option(
        '--components <json>',
        'Components map as inline JSON. Keys are ARNs or placeholders: {{runtime:<name>}}, {{gateway:<name>}}. Placeholders resolve to real ARNs at deploy time.'
      )
      .option('--components-file <path>', 'Path to components JSON file (same format as --components)')
      .option('--branch <name>', 'Branch name for versioning')
      .option('--commit-message <text>', 'Commit message for this version')
      .option('--json', 'Output as JSON')
      .action(
        async (cliOptions: {
          name?: string;
          description?: string;
          components?: string;
          componentsFile?: string;
          branch?: string;
          commitMessage?: string;
          json?: boolean;
        }) => {
          try {
            if (!findConfigRoot()) {
              console.error('No agentcore project found. Run `agentcore create` first.');
              process.exit(1);
            }

            if (cliOptions.name || cliOptions.json) {
              const fail = (error: string) => {
                if (cliOptions.json) {
                  console.log(JSON.stringify({ success: false, error }));
                } else {
                  console.error(error);
                }
                process.exit(1);
              };

              if (!cliOptions.name) {
                fail('--name is required in non-interactive mode');
              }

              if (!cliOptions.components && !cliOptions.componentsFile) {
                fail('Either --components or --components-file is required');
              }

              let components: Record<string, { configuration: Record<string, unknown> }>;
              if (cliOptions.componentsFile) {
                const raw = readFileSync(cliOptions.componentsFile, 'utf-8');
                components = JSON.parse(raw) as Record<string, { configuration: Record<string, unknown> }>;
              } else {
                components = JSON.parse(cliOptions.components!) as Record<
                  string,
                  { configuration: Record<string, unknown> }
                >;
              }

              const result = await this.add({
                name: cliOptions.name!,
                description: cliOptions.description,
                components,
                branchName: cliOptions.branch,
                commitMessage: cliOptions.commitMessage,
              });

              if (cliOptions.json) {
                console.log(JSON.stringify(serializeResult(result)));
              } else if (result.success) {
                console.log(`Added configuration bundle '${result.bundleName}'`);
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
                  initialResource: 'config-bundle',
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

  private async createConfigBundle(options: AddConfigBundleOptions): Promise<ConfigBundle> {
    const project = await this.readProjectSpec();

    this.checkDuplicate(project.configBundles ?? [], options.name);

    const bundle: ConfigBundle = {
      name: options.name,
      type: 'ConfigurationBundle',
      ...(options.description && { description: options.description }),
      components: options.components,
      branchName: options.branchName ?? 'mainline',
      ...(options.commitMessage && { commitMessage: options.commitMessage }),
    };

    project.configBundles ??= [];
    project.configBundles.push(bundle);
    await this.writeProjectSpec(project);

    return bundle;
  }
}
