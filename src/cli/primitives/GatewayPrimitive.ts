import { findConfigRoot } from '../../lib';
import type {
  AgentCoreGateway,
  AgentCoreGatewayTarget,
  AgentCoreMcpSpec,
  AgentCoreProjectSpec,
  CustomClaimValidation,
  GatewayAuthorizerType,
} from '../../schema';
import { AgentCoreGatewaySchema, PolicyEngineModeSchema } from '../../schema';
import type { AddGatewayOptions as CLIAddGatewayOptions } from '../commands/add/types';
import { validateAddGatewayOptions } from '../commands/add/validate';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, RemovalResult, SchemaChange } from '../operations/remove/types';
import { runCliCommand, withCommandRunTelemetry } from '../telemetry/cli-command-run.js';
import { AuthorizerType, PolicyEngineMode, standardize } from '../telemetry/schemas/common-shapes.js';
import { requireTTY } from '../tui/guards/tty';
import type { AddGatewayConfig } from '../tui/screens/mcp/types';
import { BasePrimitive } from './BasePrimitive';
import { buildAuthorizerConfigFromJwtConfig, createManagedOAuthCredential } from './auth-utils';
import { SOURCE_CODE_NOTE } from './constants';
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
  customClaims?: CustomClaimValidation[];
  clientId?: string;
  clientSecret?: string;
  runtimes?: string;
  enableSemanticSearch?: boolean;
  exceptionLevel?: string;
  policyEngine?: string;
  policyEngineMode?: string;
}

/** Extract MCP-related fields from a project spec. */
function extractMcpSpec(project: AgentCoreProjectSpec): AgentCoreMcpSpec {
  return {
    agentCoreGateways: project.agentCoreGateways,
    mcpRuntimeTools: project.mcpRuntimeTools,
    unassignedTargets: project.unassignedTargets,
  };
}

/**
 * GatewayPrimitive handles all gateway add/remove operations.
 * Absorbs logic from create-mcp.ts (gateway) and remove-gateway.ts.
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
      const project = await this.readProjectSpec();
      const mcpSpec = extractMcpSpec(project);

      const gateway = mcpSpec.agentCoreGateways.find(g => g.name === gatewayName);
      if (!gateway) {
        return { success: false, error: `Gateway "${gatewayName}" not found.` };
      }

      const newMcpSpec = this.computeRemovedGatewayMcpSpec(mcpSpec, gatewayName);
      await this.writeProjectSpec({ ...project, ...newMcpSpec });

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: message };
    }
  }

  async previewRemove(gatewayName: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();
    const mcpSpec = extractMcpSpec(project);

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
      file: 'agentcore/agentcore.json',
      before: project,
      after: { ...project, ...afterMcpSpec },
    });

    return { summary, directoriesToDelete: [], schemaChanges };
  }

  async getRemovable(): Promise<RemovableResource[]> {
    try {
      const project = await this.readProjectSpec();
      return project.agentCoreGateways.map(g => ({ name: g.name }));
    } catch {
      return [];
    }
  }

  /**
   * Get list of existing gateway names.
   */
  async getExistingGateways(): Promise<string[]> {
    try {
      const project = await this.readProjectSpec();
      return project.agentCoreGateways.map(g => g.name);
    } catch {
      return [];
    }
  }

  /**
   * Get list of unassigned targets from agentcore.json.
   */
  async getUnassignedTargets(): Promise<AgentCoreGatewayTarget[]> {
    try {
      const project = await this.readProjectSpec();
      return project.unassignedTargets ?? [];
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
      .command('gateway')
      .description('Add an API gateway that routes requests to agent targets')
      .option('--name <name>', 'Gateway name [non-interactive]')
      .option('--description <desc>', 'Gateway description [non-interactive]')
      .option('--runtimes <runtimes>', 'Comma-separated runtime names to expose through this gateway [non-interactive]')
      .option('--authorizer-type <type>', 'Authorizer type: NONE, AWS_IAM, or CUSTOM_JWT [non-interactive]')
      .option('--discovery-url <url>', 'OIDC discovery URL (for CUSTOM_JWT) [non-interactive]')
      .option('--allowed-audience <audience>', 'Comma-separated allowed audiences (for CUSTOM_JWT) [non-interactive]')
      .option('--allowed-clients <clients>', 'Comma-separated allowed client IDs (for CUSTOM_JWT) [non-interactive]')
      .option('--allowed-scopes <scopes>', 'Comma-separated allowed scopes (for CUSTOM_JWT) [non-interactive]')
      .option('--custom-claims <json>', 'Custom claim validations as JSON array (for CUSTOM_JWT) [non-interactive]')
      .option('--client-id <id>', 'OAuth client ID for fetching gateway bearer tokens [non-interactive]')
      .option('--client-secret <secret>', 'OAuth client secret for fetching gateway bearer tokens [non-interactive]')
      .option('--no-semantic-search', 'Disable semantic search for gateway target tool discovery [non-interactive]')
      .option(
        '--exception-level <level>',
        'Exception detail level in error responses: NONE, ALL [non-interactive]',
        'NONE'
      )
      .option('--policy-engine <name>', 'Policy engine name for Cedar-based authorization [non-interactive]')
      .option('--policy-engine-mode <mode>', 'Policy engine mode: LOG_ONLY or ENFORCE [non-interactive]')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(async (rawOptions: Record<string, string | boolean | undefined>) => {
        const cliOptions = rawOptions as unknown as CLIAddGatewayOptions;
        if (!findConfigRoot()) {
          console.error('No agentcore project found. Run `agentcore create` first.');
          process.exit(1);
        }
        await runCliCommand('add.gateway', !!cliOptions.json, async () => {
          const validation = validateAddGatewayOptions(cliOptions);
          if (!validation.valid) {
            throw new Error(validation.error);
          }

          // Parse custom claims JSON if provided (already validated)
          const parsedCustomClaims = cliOptions.customClaims
            ? (JSON.parse(cliOptions.customClaims) as CustomClaimValidation[])
            : undefined;

          const result = await this.add({
            name: cliOptions.name!,
            description: cliOptions.description,
            authorizerType: cliOptions.authorizerType ?? 'NONE',
            discoveryUrl: cliOptions.discoveryUrl,
            allowedAudience: cliOptions.allowedAudience,
            allowedClients: cliOptions.allowedClients,
            allowedScopes: cliOptions.allowedScopes,
            customClaims: parsedCustomClaims,
            clientId: cliOptions.clientId,
            clientSecret: cliOptions.clientSecret,
            runtimes: cliOptions.runtimes,
            enableSemanticSearch: cliOptions.semanticSearch !== false,
            exceptionLevel: cliOptions.exceptionLevel,
            policyEngine: cliOptions.policyEngine,
            policyEngineMode: cliOptions.policyEngineMode,
          });

          if (!result.success) {
            throw new Error(result.error);
          }

          if (cliOptions.json) {
            console.log(JSON.stringify(result));
          } else {
            console.log(`Added gateway '${result.gatewayName}'`);
          }

          const runtimeCount = cliOptions.runtimes
            ? cliOptions.runtimes
                .split(',')
                .map(s => s.trim())
                .filter(Boolean).length
            : 0;
          return {
            authorizer_type: standardize(AuthorizerType, cliOptions.authorizerType ?? 'NONE'),
            has_policy_engine: !!cliOptions.policyEngine,
            policy_engine_mode: standardize(PolicyEngineMode, cliOptions.policyEngineMode ?? 'log_only'),
            semantic_search: cliOptions.semanticSearch !== false,
            runtime_count: runtimeCount,
          };
        });
      });

    removeCmd
      .command('gateway')
      .description('Remove a gateway from the project')
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

            const result = await withCommandRunTelemetry('remove.gateway', {}, () => this.remove(cliOptions.name!));
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
      policyEngineConfiguration:
        options.policyEngine && options.policyEngineMode
          ? { policyEngineName: options.policyEngine, mode: PolicyEngineModeSchema.parse(options.policyEngineMode) }
          : undefined,
    };

    if (options.authorizerType === 'CUSTOM_JWT' && options.discoveryUrl) {
      const allowedAudience = options.allowedAudience
        ? options.allowedAudience
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : undefined;
      const allowedClients = options.allowedClients
        ? options.allowedClients
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : undefined;
      const allowedScopes = options.allowedScopes
        ? options.allowedScopes
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
        : undefined;

      config.jwtConfig = {
        discoveryUrl: options.discoveryUrl,
        ...(allowedAudience?.length ? { allowedAudience } : {}),
        ...(allowedClients?.length ? { allowedClients } : {}),
        ...(allowedScopes?.length ? { allowedScopes } : {}),
        ...(options.customClaims?.length ? { customClaims: options.customClaims } : {}),
        ...(options.clientId ? { clientId: options.clientId } : {}),
        ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
      };
    }

    return config;
  }

  /**
   * Create a gateway (absorbed from create-mcp.ts createGatewayFromWizard).
   */
  private async createGatewayFromWizard(config: AddGatewayConfig): Promise<{ name: string }> {
    const project = await this.readProjectSpec();

    if (project.agentCoreGateways.some(g => g.name === config.name)) {
      throw new Error(`Gateway "${config.name}" already exists.`);
    }

    // Move selected unassigned targets to the new gateway
    const selectedNames = new Set(config.selectedTargets ?? []);
    const movedTargets: AgentCoreGatewayTarget[] = [];
    if (selectedNames.size > 0 && project.unassignedTargets) {
      const remaining: AgentCoreGatewayTarget[] = [];
      for (const target of project.unassignedTargets) {
        if (selectedNames.has(target.name)) {
          movedTargets.push(target);
        } else {
          remaining.push(target);
        }
      }
      project.unassignedTargets = remaining.length > 0 ? remaining : undefined;
    }

    const gateway: AgentCoreGateway = {
      name: config.name,
      description: config.description,
      targets: movedTargets,
      authorizerType: config.authorizerType,
      authorizerConfiguration:
        config.authorizerType === 'CUSTOM_JWT' && config.jwtConfig
          ? buildAuthorizerConfigFromJwtConfig(config.jwtConfig)
          : undefined,
      enableSemanticSearch: config.enableSemanticSearch,
      exceptionLevel: config.exceptionLevel,
      policyEngineConfiguration: config.policyEngineConfiguration,
    };

    project.agentCoreGateways.push(gateway);
    await this.writeProjectSpec(project);

    // Auto-create OAuth credential if client credentials are provided
    if (config.jwtConfig?.clientId && config.jwtConfig?.clientSecret) {
      await createManagedOAuthCredential(
        config.name,
        config.jwtConfig,
        spec => this.writeProjectSpec(spec),
        () => this.readProjectSpec()
      );
    }

    return { name: config.name };
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
