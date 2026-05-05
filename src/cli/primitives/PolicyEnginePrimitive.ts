import { ResourceNotFoundError, findConfigRoot, serializeResult, toError } from '../../lib';
import type { Result } from '../../lib/result';
import type { AgentCoreProjectSpec, PolicyEngine } from '../../schema';
import { PolicyEngineModeSchema, PolicyEngineSchema } from '../../schema';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { runCliCommand, withCommandRunTelemetry } from '../telemetry/cli-command-run.js';
import { AttachMode, standardize } from '../telemetry/schemas/common-shapes.js';
import { requireTTY } from '../tui/guards/tty';
import { BasePrimitive } from './BasePrimitive';
import { SOURCE_CODE_NOTE } from './constants';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';

export interface AddPolicyEngineOptions {
  name: string;
  description?: string;
  encryptionKeyArn?: string;
}

export class PolicyEnginePrimitive extends BasePrimitive<AddPolicyEngineOptions, RemovableResource> {
  readonly kind = 'policy-engine' as const;
  readonly label = 'Policy Engine';
  readonly primitiveSchema = PolicyEngineSchema;

  async add(options: AddPolicyEngineOptions): Promise<AddResult<{ engineName: string }>> {
    try {
      const project = await this.readProjectSpec();

      this.checkDuplicate(project.policyEngines, options.name);

      const engine: PolicyEngine = {
        name: options.name,
        ...(options.description && { description: options.description }),
        ...(options.encryptionKeyArn && { encryptionKeyArn: options.encryptionKeyArn }),
        policies: [],
      };

      project.policyEngines.push(engine);
      await this.writeProjectSpec(project);

      return { success: true, engineName: engine.name };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async remove(engineName: string): Promise<Result> {
    try {
      const project = await this.readProjectSpec();

      const index = project.policyEngines.findIndex(e => e.name === engineName);
      if (index === -1) {
        return { success: false, error: new ResourceNotFoundError(`Policy engine "${engineName}" not found.`) };
      }

      project.policyEngines.splice(index, 1);
      await this.writeProjectSpec(project);

      // Clean up any gateway references to this engine in agentcore.json
      let changed = false;
      for (const gw of project.agentCoreGateways) {
        if (gw.policyEngineConfiguration?.policyEngineName === engineName) {
          delete gw.policyEngineConfiguration;
          changed = true;
        }
      }
      if (changed) {
        await this.writeProjectSpec(project);
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async previewRemove(engineName: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();

    const engine = project.policyEngines.find(e => e.name === engineName);
    if (!engine) {
      throw new Error(`Policy engine "${engineName}" not found.`);
    }

    const summary: string[] = [`Removing policy engine: ${engineName}`];
    if (engine.policies.length > 0) {
      summary.push(`Note: ${engine.policies.length} policy(ies) within this engine will also be removed`);
    }

    const schemaChanges: SchemaChange[] = [];
    const afterSpec: AgentCoreProjectSpec = {
      ...project,
      policyEngines: project.policyEngines.filter(e => e.name !== engineName),
    };
    schemaChanges.push({
      file: 'agentcore/agentcore.json',
      before: project,
      after: afterSpec,
    });

    // Show changes if any gateways reference this engine
    const affectedGateways = project.agentCoreGateways.filter(
      gw => gw.policyEngineConfiguration?.policyEngineName === engineName
    );
    if (affectedGateways.length > 0) {
      summary.push(
        `Note: ${affectedGateways.length} gateway(s) referencing this engine will have policyEngineConfiguration removed`
      );
      summary.push(
        'Warning: this may grant agents escalated permissions to invoke gateway tools that were previously restricted'
      );
    }

    return { summary, directoriesToDelete: [], schemaChanges };
  }

  async getRemovable(): Promise<RemovableResource[]> {
    try {
      const project = await this.readProjectSpec();
      return project.policyEngines.map(e => ({ name: e.name }));
    } catch {
      return [];
    }
  }

  async getExistingEngines(): Promise<string[]> {
    try {
      const project = await this.readProjectSpec();
      return project.policyEngines.map(e => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Get gateway names that don't have a policy engine attached.
   */
  async getUnprotectedGateways(): Promise<string[]> {
    try {
      const project = await this.readProjectSpec();
      return project.agentCoreGateways.filter(gw => !gw.policyEngineConfiguration).map(gw => gw.name);
    } catch {
      return [];
    }
  }

  /**
   * Attach a policy engine to the specified gateways in agentcore.json.
   */
  async attachToGateways(engineName: string, gatewayNames: string[], mode: 'LOG_ONLY' | 'ENFORCE'): Promise<void> {
    if (gatewayNames.length === 0) return;
    const project = await this.readProjectSpec();
    const nameSet = new Set(gatewayNames);
    for (const gw of project.agentCoreGateways) {
      if (nameSet.has(gw.name)) {
        gw.policyEngineConfiguration = { policyEngineName: engineName, mode };
      }
    }
    await this.writeProjectSpec(project);
  }

  async getDeployedEngineId(engineName: string): Promise<string | null> {
    try {
      const deployedState = await this.configIO.readDeployedState();
      for (const target of Object.values(deployedState.targets)) {
        const engineState = target.resources?.policyEngines?.[engineName];
        if (engineState) {
          return engineState.policyEngineId;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async getDeployedGatewayArn(): Promise<string | null> {
    const gateways = await this.getDeployedGateways();
    const firstArn = Object.values(gateways)[0];
    return firstArn ?? null;
  }

  async getDeployedGateways(): Promise<Record<string, string>> {
    try {
      const deployedState = await this.configIO.readDeployedState();
      const result: Record<string, string> = {};
      for (const target of Object.values(deployedState.targets)) {
        const gateways = target.resources?.mcp?.gateways;
        if (gateways) {
          for (const [name, gw] of Object.entries(gateways)) {
            if (gw?.gatewayArn) {
              result[name] = gw.gatewayArn;
            }
          }
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('policy-engine')
      .description('Add a policy engine to the project')
      .option('--name <name>', 'Policy engine name [non-interactive]')
      .option('--description <desc>', 'Policy engine description [non-interactive]')
      .option('--encryption-key-arn <arn>', 'KMS encryption key ARN [non-interactive]')
      .option(
        '--attach-to-gateways <gateways>',
        'Comma-separated gateway names to attach this engine to [non-interactive]'
      )
      .option('--attach-mode <mode>', 'Enforcement mode for attached gateways: LOG_ONLY or ENFORCE [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(
        async (cliOptions: {
          name?: string;
          description?: string;
          encryptionKeyArn?: string;
          attachToGateways?: string;
          attachMode?: string;
          json?: boolean;
        }) => {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          if (cliOptions.name || cliOptions.description || cliOptions.encryptionKeyArn || cliOptions.json) {
            await runCliCommand('add.policy-engine', !!cliOptions.json, async () => {
              if (!cliOptions.name) {
                throw new Error('--name is required');
              }

              const result = await this.add({
                name: cliOptions.name,
                description: cliOptions.description,
                encryptionKeyArn: cliOptions.encryptionKeyArn,
              });

              // Attach to gateways if requested
              if (result.success && cliOptions.attachToGateways) {
                const mode = PolicyEngineModeSchema.parse(cliOptions.attachMode ?? 'LOG_ONLY');
                const gateways = cliOptions.attachToGateways
                  .split(',')
                  .map(s => s.trim())
                  .filter(Boolean);
                await this.attachToGateways(cliOptions.name, gateways, mode);
              }

              if (!result.success) {
                throw result.error;
              }

              if (cliOptions.json) {
                console.log(JSON.stringify(serializeResult(result)));
              } else {
                console.log(`Added policy engine '${result.engineName}'`);
              }

              const gatewayCount = cliOptions.attachToGateways
                ? cliOptions.attachToGateways
                    .split(',')
                    .map(s => s.trim())
                    .filter(Boolean).length
                : 0;
              return {
                attach_gateway_count: gatewayCount,
                attach_mode: standardize(AttachMode, cliOptions.attachMode ?? 'log_only'),
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
      .command('policy-engine')
      .description('Remove a policy engine from the project')
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

            const result = await withCommandRunTelemetry('remove.policy-engine', {}, () =>
              this.remove(cliOptions.name!)
            );
            if (cliOptions.json) {
              console.log(
                JSON.stringify({
                  success: result.success,
                  resourceType: this.kind,
                  resourceName: cliOptions.name,
                  message: result.success ? `Removed policy engine '${cliOptions.name}'` : undefined,
                  note: result.success ? SOURCE_CODE_NOTE : undefined,
                  error: !result.success ? result.error.message : undefined,
                })
              );
            } else if (result.success) {
              console.log(`Removed policy engine '${cliOptions.name}'`);
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
