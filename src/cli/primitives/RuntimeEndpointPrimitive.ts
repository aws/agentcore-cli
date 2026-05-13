import {
  ConflictError,
  ResourceNotFoundError,
  ValidationError,
  findConfigRoot,
  serializeResult,
  toError,
} from '../../lib';
import type { Result } from '../../lib/result';
import type { AgentCoreProjectSpec } from '../../schema';
import { RuntimeEndpointSchema } from '../../schema';
import type { ResourceType } from '../commands/remove/types';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { runCliCommand, withCommandRunTelemetry } from '../telemetry/cli-command-run.js';
import { BasePrimitive } from './BasePrimitive';
import { SOURCE_CODE_NOTE } from './constants';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';

/**
 * Options for adding a runtime endpoint (CLI-level).
 */
export interface AddRuntimeEndpointOptions {
  runtime: string;
  endpoint: string;
  version?: number;
  description?: string;
}

/**
 * Represents a runtime endpoint that can be removed.
 */
export interface RemovableRuntimeEndpoint extends RemovableResource {
  runtimeName: string;
  endpointName: string;
  version: number;
  description?: string;
}

/**
 * RuntimeEndpointPrimitive handles all runtime endpoint (version alias) add/remove operations.
 * Endpoints are sub-resources of runtimes, stored in the `endpoints` dictionary on each runtime.
 */
export class RuntimeEndpointPrimitive extends BasePrimitive<AddRuntimeEndpointOptions, RemovableRuntimeEndpoint> {
  readonly kind: ResourceType = 'runtime-endpoint';
  readonly label = 'Runtime Endpoint';
  readonly primitiveSchema = RuntimeEndpointSchema;

  async add(options: AddRuntimeEndpointOptions): Promise<AddResult> {
    try {
      const project = await this.readProjectSpec();

      // Find the parent runtime
      const runtime = project.runtimes.find(a => a.name === options.runtime);
      if (!runtime) {
        return { success: false, error: new ResourceNotFoundError(`Runtime "${options.runtime}" not found.`) };
      }

      // Initialize endpoints dictionary if needed
      runtime.endpoints ??= {};

      // Check for duplicate endpoint name
      if (runtime.endpoints[options.endpoint]) {
        return {
          success: false,
          error: new ConflictError(`Endpoint "${options.endpoint}" already exists on runtime "${options.runtime}".`),
        };
      }

      // Validate version is a positive integer
      const version = options.version ?? 1;
      if (!Number.isInteger(version) || version < 1) {
        return { success: false, error: new ValidationError(`Version must be a positive integer (got ${version}).`) };
      }

      // Check version against latest deployed version
      try {
        if (this.configIO.configExists('state')) {
          const deployedState = await this.configIO.readDeployedState();
          for (const target of Object.values(deployedState.targets)) {
            const deployedRuntime = target.resources?.runtimes?.[options.runtime];
            if (deployedRuntime?.runtimeVersion && version > deployedRuntime.runtimeVersion) {
              return {
                success: false,
                error: new ValidationError(
                  `Version ${version} exceeds latest deployed version ${deployedRuntime.runtimeVersion} for runtime "${options.runtime}".`
                ),
              };
            }
          }
        }
      } catch {
        // Deployed state may not exist or be readable — skip version range check
      }

      // Build and validate the endpoint config
      const config = {
        version,
        ...(options.description ? { description: options.description } : {}),
      };
      RuntimeEndpointSchema.parse(config);

      // Set the endpoint on the runtime
      runtime.endpoints[options.endpoint] = config;

      // Write updated project spec
      await this.writeProjectSpec(project);

      return {
        success: true,
        endpointName: options.endpoint,
        agent: options.runtime,
        version: config.version,
      };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async remove(name: string): Promise<Result> {
    try {
      const project = await this.readProjectSpec();

      // Support composite key: runtimeName/endpointName
      const slashIndex = name.indexOf('/');
      if (slashIndex > 0) {
        const runtimeName = name.substring(0, slashIndex);
        const endpointName = name.substring(slashIndex + 1);
        const runtime = project.runtimes.find(r => r.name === runtimeName);
        if (!runtime?.endpoints?.[endpointName]) {
          return { success: false, error: new ResourceNotFoundError(`Runtime endpoint "${name}" not found.`) };
        }
        delete runtime.endpoints[endpointName];
        if (Object.keys(runtime.endpoints).length === 0) {
          delete runtime.endpoints;
        }
        await this.writeProjectSpec(project);
        return { success: true };
      }

      // Legacy: bare endpoint name — search all runtimes
      for (const runtime of project.runtimes) {
        if (runtime.endpoints?.[name]) {
          delete runtime.endpoints[name];
          if (Object.keys(runtime.endpoints).length === 0) {
            delete runtime.endpoints;
          }
          await this.writeProjectSpec(project);
          return { success: true };
        }
      }

      return { success: false, error: new ResourceNotFoundError(`Runtime endpoint "${name}" not found.`) };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async previewRemove(name: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();

    // Support composite key: runtimeName/endpointName
    let runtimeName: string | undefined;
    let endpointName: string = name;
    let endpointConfig: { version: number; description?: string } | undefined;

    const slashIndex = name.indexOf('/');
    if (slashIndex > 0) {
      runtimeName = name.substring(0, slashIndex);
      endpointName = name.substring(slashIndex + 1);
      const runtime = project.runtimes.find(r => r.name === runtimeName);
      if (runtime?.endpoints?.[endpointName]) {
        endpointConfig = runtime.endpoints[endpointName];
      }
    } else {
      // Legacy: bare endpoint name — search all runtimes
      for (const runtime of project.runtimes) {
        if (runtime.endpoints?.[name]) {
          runtimeName = runtime.name;
          endpointConfig = runtime.endpoints[name];
          break;
        }
      }
    }

    if (!runtimeName || !endpointConfig) {
      throw new Error(`Runtime endpoint "${name}" not found.`);
    }

    const summary: string[] = [];
    const schemaChanges: SchemaChange[] = [];

    summary.push(`Removing runtime endpoint: ${endpointName} (from runtime "${runtimeName}")`);
    summary.push(`  Version: ${endpointConfig.version}`);
    if (endpointConfig.description) {
      summary.push(`  Description: ${endpointConfig.description}`);
    }

    // Build after state
    const afterProject = JSON.parse(JSON.stringify(project)) as AgentCoreProjectSpec;
    const afterRuntime = afterProject.runtimes.find(a => a.name === runtimeName);
    if (afterRuntime?.endpoints) {
      delete afterRuntime.endpoints[endpointName];
      if (Object.keys(afterRuntime.endpoints).length === 0) {
        delete afterRuntime.endpoints;
      }
    }

    schemaChanges.push({
      file: 'agentcore/agentcore.json',
      before: project,
      after: afterProject,
    });

    return { summary, directoriesToDelete: [], schemaChanges };
  }

  async getRemovable(): Promise<RemovableRuntimeEndpoint[]> {
    try {
      const project = await this.readProjectSpec();
      const removable: RemovableRuntimeEndpoint[] = [];

      for (const runtime of project.runtimes) {
        if (!runtime.endpoints) continue;

        for (const [endpointName, endpointConfig] of Object.entries(runtime.endpoints)) {
          removable.push({
            name: `${runtime.name}/${endpointName}`,
            type: 'runtime-endpoint',
            runtimeName: runtime.name,
            endpointName,
            version: endpointConfig.version,
            description: endpointConfig.description,
          });
        }
      }

      return removable;
    } catch {
      return [];
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('runtime-endpoint')
      .description('Add a named endpoint (version alias) to a runtime')
      .requiredOption('--runtime <name>', 'Runtime name to add the endpoint to')
      .requiredOption('--endpoint <name>', 'Endpoint name (e.g., prod, staging)')
      .option('--version <number>', 'Version number to alias (default: 1)', Number)
      .option('--description <desc>', 'Description of the endpoint')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(
        async (cliOptions: {
          runtime: string;
          endpoint: string;
          version?: number;
          description?: string;
          json?: boolean;
        }) => {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          await runCliCommand('add.runtime-endpoint', !!cliOptions.json, async () => {
            const result = await this.add({
              runtime: cliOptions.runtime,
              endpoint: cliOptions.endpoint,
              version: cliOptions.version,
              description: cliOptions.description,
            });

            if (!result.success) {
              throw result.error;
            }

            if (cliOptions.json) {
              console.log(JSON.stringify(serializeResult(result)));
            } else {
              console.log(`Added runtime endpoint '${cliOptions.endpoint}' to runtime '${cliOptions.runtime}'`);
            }

            return {};
          });
        }
      );

    removeCmd
      .command('runtime-endpoint')
      .description('Remove a runtime endpoint from the project')
      .option('--name <name>', 'Name of resource to remove [non-interactive]')
      .option('-y, --yes', 'Skip confirmation prompt [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(async (cliOptions: { name?: string; yes?: boolean; json?: boolean }) => {
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

            const result = await withCommandRunTelemetry('remove.runtime-endpoint', {}, () =>
              this.remove(cliOptions.name!)
            );
            console.log(
              JSON.stringify({
                success: result.success,
                resourceType: this.kind,
                resourceName: cliOptions.name,
                message: result.success ? `Removed runtime endpoint '${cliOptions.name}'` : undefined,
                note: result.success ? SOURCE_CODE_NOTE : undefined,
                error: !result.success ? result.error.message : undefined,
              })
            );
            process.exit(result.success ? 0 : 1);
          } else {
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

  /**
   * Stub for future cross-reference validation.
   * Checks if any gateway targets reference a given runtime endpoint.
   */
}
