import { findConfigRoot, setEnvVar } from '../../lib';
import type { AgentCoreGateway, AgentCoreGatewayTarget, AgentCoreMcpSpec, GatewayAuthorizerType } from '../../schema';
import { AgentCoreGatewaySchema } from '../../schema';
import type { AddGatewayOptions as CLIAddGatewayOptions } from '../commands/add/types';
import { validateAddGatewayOptions } from '../commands/add/validate';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, RemovalResult, SchemaChange } from '../operations/remove/types';
import type { AddGatewayConfig } from '../tui/screens/mcp/types';
import { BasePrimitive } from './BasePrimitive';
import { SOURCE_CODE_NOTE } from './constants';
import { computeDefaultCredentialEnvVarName, computeManagedOAuthCredentialName } from './credential-utils';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';

/**
 * Options for adding a gateway resource (CLI-level).
 */
export interface AddGatewayOptions {
  name: string;
  description?: string;
  authorizerType: GatewayAuthorizerType;
  discoveryUrl?: string;
  allowedAudience?: string;
  allowedClients?: string;
  allowedScopes?: string;
  agentClientId?: string;
  agentClientSecret?: string;
  agents?: string;
  enableSemanticSearch?: boolean;
  exceptionLevel?: string;
}

/**
 * GatewayPrimitive handles all gateway add/remove operations.
 * Absorbs logic from create-mcp.ts (gateway) and remove-gateway.ts.
 * Uses mcp.json instead of agentcore.json.
 */
export class GatewayPrimitive extends BasePrimitive<AddGatewayOptions, RemovableResource> {
  readonly kind = 'gateway';
  readonly label = 'Gateway';
  readonly primitiveSchema = AgentCoreGatewaySchema;

  async add(options: AddGatewayOptions): Promise<AddResult<{ gatewayName: string }>> {
    try {
      const config = this.buildGatewayConfig(options);
      const result = await this.createGatewayFromWizard(config);
      return { success: true, gatewayName: result.name };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  }

  async remove(gatewayName: string): Promise<RemovalResult> {
    try {
      const mcpSpec = await this.configIO.readMcpSpec();

      const gateway = mcpSpec.agentCoreGateways.find(g => g.name === gatewayName);
      if (!gateway) {
        return { success: false, error: `Gateway "${gatewayName}" not found.` };
      }

      const newMcpSpec = this.computeRemovedGatewayMcpSpec(mcpSpec, gatewayName);
      await this.configIO.writeMcpSpec(newMcpSpec);

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: message };
    }
  }

  async previewRemove(gatewayName: string): Promise<RemovalPreview> {
    const mcpSpec = await this.configIO.readMcpSpec();

    const gateway = mcpSpec.agentCoreGateways.find(g => g.name === gatewayName);
    if (!gateway) {
      throw new Error(`Gateway "${gatewayName}" not found.`);
    }

    const summary: string[] = [`Removing gateway: ${gatewayName}`];
    const schemaChanges: SchemaChange[] = [];

    if (gateway.targets.length > 0) {
      summary.push(`Note: ${gateway.targets.length} target(s) behind this gateway will become unassigned`);
    }

    const afterMcpSpec = this.computeRemovedGatewayMcpSpec(mcpSpec, gatewayName);
    schemaChanges.push({
      file: 'agentcore/mcp.json',
      before: mcpSpec,
      after: afterMcpSpec,
    });

    return { summary, directoriesToDelete: [], schemaChanges };
  }

  async getRemovable(): Promise<RemovableResource[]> {
    try {
      if (!this.configIO.configExists('mcp')) {
        return [];
      }
      const mcpSpec = await this.configIO.readMcpSpec();
      return mcpSpec.agentCoreGateways.map(g => ({ name: g.name }));
    } catch {
      return [];
    }
  }

  /**
   * Get list of existing gateway names.
   */
  async getExistingGateways(): Promise<string[]> {
    try {
      if (!this.configIO.configExists('mcp')) {
        return [];
      }
      const mcpSpec = await this.configIO.readMcpSpec();
      return mcpSpec.agentCoreGateways.map(g => g.name);
    } catch {
      return [];
    }
  }

  /**
   * Get list of unassigned targets from mcp.json.
   */
  async getUnassignedTargets(): Promise<AgentCoreGatewayTarget[]> {
    try {
      if (!this.configIO.configExists('mcp')) {
        return [];
      }
      const mcpSpec = await this.configIO.readMcpSpec();
      return mcpSpec.unassignedTargets ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Compute the default env var name for a gateway.
   */
  static computeDefaultGatewayEnvVarName(gatewayName: string): string {
    const sanitized = gatewayName.toUpperCase().replace(/-/g, '_');
    return `AGENTCORE_GATEWAY_${sanitized}_URL`;
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('gateway', { hidden: true })
      .description('Add a gateway to the project')
      .option('--name <name>', 'Gateway name')
      .option('--description <desc>', 'Gateway description')
      .option('--authorizer-type <type>', 'Authorizer type: NONE or CUSTOM_JWT')
      .option('--discovery-url <url>', 'OIDC discovery URL (for CUSTOM_JWT)')
      .option('--allowed-audience <audience>', 'Comma-separated allowed audiences (for CUSTOM_JWT)')
      .option('--allowed-clients <clients>', 'Comma-separated allowed client IDs (for CUSTOM_JWT)')
      .option('--allowed-scopes <scopes>', 'Comma-separated allowed scopes (for CUSTOM_JWT)')
      .option('--agent-client-id <id>', 'Agent OAuth client ID')
      .option('--agent-client-secret <secret>', 'Agent OAuth client secret')
      .option('--agents <agents>', 'Comma-separated agent names')
      .option('--no-semantic-search', 'Disable semantic search for tool discovery')
      .option('--exception-level <level>', 'Exception verbosity level', 'NONE')
      .option('--json', 'Output as JSON')
      .action(async (rawOptions: Record<string, string | boolean | undefined>) => {
        const cliOptions = rawOptions as unknown as CLIAddGatewayOptions;
        try {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          const validation = validateAddGatewayOptions(cliOptions);
          if (!validation.valid) {
            if (cliOptions.json) {
              console.log(JSON.stringify({ success: false, error: validation.error }));
            } else {
              console.error(validation.error);
            }
            process.exit(1);
          }

          const result = await this.add({
            name: cliOptions.name!,
            description: cliOptions.description,
            authorizerType: cliOptions.authorizerType ?? 'NONE',
            discoveryUrl: cliOptions.discoveryUrl,
            allowedAudience: cliOptions.allowedAudience,
            allowedClients: cliOptions.allowedClients,
            allowedScopes: cliOptions.allowedScopes,
            agentClientId: cliOptions.agentClientId,
            agentClientSecret: cliOptions.agentClientSecret,
            agents: cliOptions.agents,
            enableSemanticSearch: cliOptions.semanticSearch !== false,
            exceptionLevel: cliOptions.exceptionLevel,
          });

          if (cliOptions.json) {
            console.log(JSON.stringify(result));
          } else if (result.success) {
            console.log(`Added gateway '${result.gatewayName}'`);
          } else {
            console.error(result.error);
          }

          process.exit(result.success ? 0 : 1);
        } catch (error) {
          if (cliOptions.json) {
            console.log(JSON.stringify({ success: false, error: getErrorMessage(error) }));
          } else {
            console.error(`Error: ${getErrorMessage(error)}`);
          }
          process.exit(1);
        }
      });

    removeCmd
      .command('gateway', { hidden: true })
      .description('Remove a gateway from the project')
      .option('--name <name>', 'Name of resource to remove')
      .option('--force', 'Skip confirmation prompt')
      .option('--json', 'Output as JSON')
      .action(async (cliOptions: { name?: string; force?: boolean; json?: boolean }) => {
        try {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          if (cliOptions.name || cliOptions.force || cliOptions.json) {
            if (!cliOptions.name) {
              console.log(JSON.stringify({ success: false, error: '--name is required' }));
              process.exit(1);
            }

            const result = await this.remove(cliOptions.name);
            console.log(
              JSON.stringify({
                success: result.success,
                resourceType: this.kind,
                resourceName: cliOptions.name,
                message: result.success ? `Removed gateway '${cliOptions.name}'` : undefined,
                note: result.success ? SOURCE_CODE_NOTE : undefined,
                error: !result.success ? result.error : undefined,
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
                force: cliOptions.force,
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
   * Build gateway config from CLI options.
   */
  private buildGatewayConfig(options: AddGatewayOptions): AddGatewayConfig {
    const config: AddGatewayConfig = {
      name: options.name,
      description: options.description ?? `Gateway for ${options.name}`,
      authorizerType: options.authorizerType,
      jwtConfig: undefined,
      enableSemanticSearch: options.enableSemanticSearch ?? true,
      exceptionLevel: options.exceptionLevel === 'DEBUG' ? 'DEBUG' : 'NONE',
    };

    if (options.authorizerType === 'CUSTOM_JWT' && options.discoveryUrl) {
      config.jwtConfig = {
        discoveryUrl: options.discoveryUrl,
        allowedAudience: options.allowedAudience
          ? options.allowedAudience
              .split(',')
              .map(s => s.trim())
              .filter(Boolean)
          : [],
        allowedClients: options.allowedClients
          ? options.allowedClients
              .split(',')
              .map(s => s.trim())
              .filter(Boolean)
          : [],
        ...(options.allowedScopes
          ? {
              allowedScopes: options.allowedScopes
                .split(',')
                .map(s => s.trim())
                .filter(Boolean),
            }
          : {}),
        ...(options.agentClientId ? { agentClientId: options.agentClientId } : {}),
        ...(options.agentClientSecret ? { agentClientSecret: options.agentClientSecret } : {}),
      };
    }

    return config;
  }

  /**
   * Create a gateway (absorbed from create-mcp.ts createGatewayFromWizard).
   */
  private async createGatewayFromWizard(config: AddGatewayConfig): Promise<{ name: string }> {
    const mcpSpec: AgentCoreMcpSpec = this.configIO.configExists('mcp')
      ? await this.configIO.readMcpSpec()
      : { agentCoreGateways: [] };

    if (mcpSpec.agentCoreGateways.some(g => g.name === config.name)) {
      throw new Error(`Gateway "${config.name}" already exists.`);
    }

    // Move selected unassigned targets to the new gateway
    const selectedNames = new Set(config.selectedTargets ?? []);
    const movedTargets: AgentCoreGatewayTarget[] = [];
    if (selectedNames.size > 0 && mcpSpec.unassignedTargets) {
      const remaining: AgentCoreGatewayTarget[] = [];
      for (const target of mcpSpec.unassignedTargets) {
        if (selectedNames.has(target.name)) {
          movedTargets.push(target);
        } else {
          remaining.push(target);
        }
      }
      mcpSpec.unassignedTargets = remaining.length > 0 ? remaining : undefined;
    }

    const gateway: AgentCoreGateway = {
      name: config.name,
      description: config.description,
      targets: movedTargets,
      authorizerType: config.authorizerType,
      authorizerConfiguration: this.buildAuthorizerConfiguration(config),
      enableSemanticSearch: config.enableSemanticSearch,
      exceptionLevel: config.exceptionLevel,
    };

    mcpSpec.agentCoreGateways.push(gateway);
    await this.configIO.writeMcpSpec(mcpSpec);

    // Auto-create OAuth credential if agent client credentials are provided
    if (config.jwtConfig?.agentClientId && config.jwtConfig?.agentClientSecret) {
      await this.createManagedOAuthCredential(config.name, config.jwtConfig);
    }

    return { name: config.name };
  }

  /**
   * Auto-create a managed OAuth credential for gateway inbound auth.
   * Stores the credential in agentcore.json and writes the client secret to .env.
   */
  private async createManagedOAuthCredential(
    gatewayName: string,
    jwtConfig: NonNullable<AddGatewayConfig['jwtConfig']>
  ): Promise<void> {
    const credentialName = computeManagedOAuthCredentialName(gatewayName);
    const project = await this.readProjectSpec();

    // Skip if credential already exists
    if (project.credentials.some(c => c.name === credentialName)) {
      return;
    }

    project.credentials.push({
      type: 'OAuthCredentialProvider',
      name: credentialName,
      discoveryUrl: jwtConfig.discoveryUrl,
      vendor: 'CustomOauth2',
      managed: true,
      usage: 'inbound',
    });
    await this.writeProjectSpec(project);

    // Write client secret to .env
    const envVarName = computeDefaultCredentialEnvVarName(credentialName);
    await setEnvVar(envVarName, jwtConfig.agentClientSecret!);
  }

  /**
   * Build authorizer configuration from wizard config.
   */
  private buildAuthorizerConfiguration(config: AddGatewayConfig): AgentCoreGateway['authorizerConfiguration'] {
    if (config.authorizerType !== 'CUSTOM_JWT' || !config.jwtConfig) {
      return undefined;
    }

    return {
      customJwtAuthorizer: {
        discoveryUrl: config.jwtConfig.discoveryUrl,
        allowedAudience: config.jwtConfig.allowedAudience,
        allowedClients: config.jwtConfig.allowedClients,
        ...(config.jwtConfig.allowedScopes && config.jwtConfig.allowedScopes.length > 0
          ? { allowedScopes: config.jwtConfig.allowedScopes }
          : {}),
      },
    };
  }

  /**
   * Compute MCP spec after removing a gateway.
   * Moves the gateway's targets to unassignedTargets so they are preserved.
   */
  private computeRemovedGatewayMcpSpec(mcpSpec: AgentCoreMcpSpec, gatewayName: string): AgentCoreMcpSpec {
    const gateway = mcpSpec.agentCoreGateways.find(g => g.name === gatewayName);
    const orphanedTargets = gateway?.targets ?? [];
    const existingUnassigned = mcpSpec.unassignedTargets ?? [];
    const mergedUnassigned = [...existingUnassigned, ...orphanedTargets];

    return {
      ...mcpSpec,
      agentCoreGateways: mcpSpec.agentCoreGateways.filter(g => g.name !== gatewayName),
      ...(mergedUnassigned.length > 0 ? { unassignedTargets: mergedUnassigned } : {}),
    };
  }
}
