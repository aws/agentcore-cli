import { APP_DIR, MCP_APP_SUBDIR, findConfigRoot, requireConfigRoot } from '../../lib';
import type {
  AgentCoreCliMcpDefs,
  AgentCoreGatewayTarget,
  AgentCoreMcpSpec,
  ApiGatewayHttpMethod,
  DirectoryPath,
  FilePath,
} from '../../schema';
import { AgentCoreCliMcpDefsSchema, AgentCoreGatewayTargetSchema, ToolDefinitionSchema } from '../../schema';
import type { AddGatewayTargetOptions as CLIAddGatewayTargetOptions } from '../commands/add/types';
import { validateAddGatewayTargetOptions } from '../commands/add/validate';
import { getErrorMessage } from '../errors';
import type { RemovableGatewayTarget } from '../operations/remove/remove-gateway-target';
import type { RemovalPreview, RemovalResult, SchemaChange } from '../operations/remove/types';
import { getTemplateToolDefinitions, renderGatewayTargetTemplate } from '../templates/GatewayTargetRenderer';
import type { ApiGatewayTargetConfig, GatewayTargetWizardState, McpServerTargetConfig } from '../tui/screens/mcp/types';
import { DEFAULT_HANDLER, DEFAULT_NODE_VERSION, DEFAULT_PYTHON_VERSION } from '../tui/screens/mcp/types';
import { BasePrimitive } from './BasePrimitive';
import { SOURCE_CODE_NOTE } from './constants';
import type { AddResult, AddScreenComponent } from './types';
import type { Command } from '@commander-js/extra-typings';
import { existsSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

const MCP_DEFS_FILE = 'mcp-defs.json';

/**
 * Options for adding a gateway target (CLI-level).
 */
export interface AddGatewayTargetOptions {
  name: string;
  description?: string;
  language: 'Python' | 'TypeScript' | 'Other';
  gateway?: string;
  host?: 'Lambda' | 'AgentCoreRuntime';
}

/**
 * GatewayTargetPrimitive handles all gateway target add/remove operations.
 * Absorbs logic from create-mcp.ts (tool) and remove-gateway-target.ts.
 * Uses mcp.json and mcp-defs.json instead of agentcore.json.
 */
export class GatewayTargetPrimitive extends BasePrimitive<AddGatewayTargetOptions, RemovableGatewayTarget> {
  readonly kind = 'gateway-target';
  readonly label = 'Gateway Target';
  readonly primitiveSchema = AgentCoreGatewayTargetSchema;

  async add(options: AddGatewayTargetOptions): Promise<AddResult<{ toolName: string; sourcePath: string }>> {
    try {
      const config = this.buildGatewayTargetConfig(options);
      const result = await this.createToolFromWizard(config);
      return { success: true, toolName: result.toolName, sourcePath: result.projectPath };
    } catch (err) {
      return { success: false, error: getErrorMessage(err) };
    }
  }

  async remove(name: string): Promise<RemovalResult> {
    // Find the target by name to get its gateway info
    const tools = await this.getRemovable();
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      return { success: false, error: `Gateway target "${name}" not found.` };
    }
    return this.removeGatewayTarget(tool);
  }

  async previewRemove(name: string): Promise<RemovalPreview> {
    const tools = await this.getRemovable();
    const tool = tools.find(t => t.name === name);
    if (!tool) {
      throw new Error(`Gateway target "${name}" not found.`);
    }
    return this.previewRemoveGatewayTarget(tool);
  }

  async getRemovable(): Promise<RemovableGatewayTarget[]> {
    try {
      if (!this.configIO.configExists('mcp')) {
        return [];
      }
      const mcpSpec = await this.configIO.readMcpSpec();
      const tools: RemovableGatewayTarget[] = [];

      // Gateway targets
      for (const gateway of mcpSpec.agentCoreGateways) {
        for (const target of gateway.targets) {
          tools.push({
            name: target.name,
            type: 'gateway-target',
            gatewayName: gateway.name,
          });
        }
      }

      return tools;
    } catch {
      return [];
    }
  }

  /**
   * Preview removal of a specific gateway target (with full target info).
   */
  async previewRemoveGatewayTarget(tool: RemovableGatewayTarget): Promise<RemovalPreview> {
    const mcpSpec = await this.configIO.readMcpSpec();
    const mcpDefs = this.configIO.configExists('mcpDefs') ? await this.configIO.readMcpDefs() : { tools: {} };

    const summary: string[] = [];
    const directoriesToDelete: string[] = [];
    const schemaChanges: SchemaChange[] = [];
    const projectRoot = this.configIO.getProjectRoot();

    const gateway = mcpSpec.agentCoreGateways.find(g => g.name === tool.gatewayName);
    if (!gateway) {
      throw new Error(`Gateway "${tool.gatewayName}" not found.`);
    }

    const target = gateway.targets.find(t => t.name === tool.name);
    if (!target) {
      throw new Error(`Target "${tool.name}" not found in gateway "${tool.gatewayName}".`);
    }

    summary.push(`Removing gateway target: ${tool.name} (from ${tool.gatewayName})`);

    if (target.compute?.implementation && 'path' in target.compute.implementation) {
      const toolPath = target.compute.implementation.path;
      const toolDir = join(projectRoot, toolPath);
      if (existsSync(toolDir)) {
        directoriesToDelete.push(toolDir);
        summary.push(`Deleting directory: ${toolPath}`);
      }
    }

    for (const toolDef of target.toolDefinitions ?? []) {
      if (mcpDefs.tools[toolDef.name]) {
        summary.push(`Removing tool definition: ${toolDef.name}`);
      }
    }

    const afterMcpSpec = this.computeRemovedToolMcpSpec(mcpSpec, tool);
    schemaChanges.push({
      file: 'agentcore/mcp.json',
      before: mcpSpec,
      after: afterMcpSpec,
    });

    const afterMcpDefs = this.computeRemovedToolMcpDefs(mcpSpec, mcpDefs, tool);
    if (JSON.stringify(mcpDefs) !== JSON.stringify(afterMcpDefs)) {
      schemaChanges.push({
        file: 'agentcore/mcp-defs.json',
        before: mcpDefs,
        after: afterMcpDefs,
      });
    }

    return { summary, directoriesToDelete, schemaChanges };
  }

  /**
   * Remove a gateway target (with full target info).
   */
  async removeGatewayTarget(tool: RemovableGatewayTarget): Promise<RemovalResult> {
    try {
      const mcpSpec = await this.configIO.readMcpSpec();
      const mcpDefs = this.configIO.configExists('mcpDefs') ? await this.configIO.readMcpDefs() : { tools: {} };
      const projectRoot = this.configIO.getProjectRoot();

      // Find the tool path for deletion
      let toolPath: string | undefined;

      const gateway = mcpSpec.agentCoreGateways.find(g => g.name === tool.gatewayName);
      if (!gateway) {
        return { success: false, error: `Gateway "${tool.gatewayName}" not found.` };
      }
      const target = gateway.targets.find(t => t.name === tool.name);
      if (!target) {
        return { success: false, error: `Target "${tool.name}" not found in gateway "${tool.gatewayName}".` };
      }
      if (target.compute?.implementation && 'path' in target.compute.implementation) {
        toolPath = target.compute.implementation.path;
      }

      // Update MCP spec
      const newMcpSpec = this.computeRemovedToolMcpSpec(mcpSpec, tool);
      await this.configIO.writeMcpSpec(newMcpSpec);

      // Update MCP defs
      const newMcpDefs = this.computeRemovedToolMcpDefs(mcpSpec, mcpDefs, tool);
      await this.configIO.writeMcpDefs(newMcpDefs);

      // Delete tool directory if it exists
      if (toolPath) {
        const toolDir = join(projectRoot, toolPath);
        if (existsSync(toolDir)) {
          await rm(toolDir, { recursive: true, force: true });
        }
      }

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { success: false, error: message };
    }
  }

  /**
   * Get list of existing tool names from MCP spec.
   */
  async getExistingToolNames(): Promise<string[]> {
    try {
      if (!this.configIO.configExists('mcp')) {
        return [];
      }
      const mcpSpec = await this.configIO.readMcpSpec();
      const toolNames: string[] = [];

      for (const gateway of mcpSpec.agentCoreGateways) {
        for (const target of gateway.targets) {
          for (const toolDef of target.toolDefinitions ?? []) {
            toolNames.push(toolDef.name);
          }
        }
      }

      return toolNames;
    } catch {
      return [];
    }
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command('gateway-target', { hidden: true })
      .description('Add a gateway target to the project')
      .option('--name <name>', 'Target name')
      .option('--description <desc>', 'Target description')
      .option('--type <type>', 'Target type (required): mcp-server, api-gateway')
      .option('--endpoint <url>', 'MCP server endpoint URL')
      .option('--language <lang>', 'Language: Python, TypeScript, Other')
      .option('--gateway <name>', 'Gateway name')
      .option('--host <host>', 'Compute host: Lambda or AgentCoreRuntime')
      .option('--outbound-auth <type>', 'Outbound auth type: oauth, api-key, or none')
      .option('--credential-name <name>', 'Existing credential name for outbound auth')
      .option('--oauth-client-id <id>', 'OAuth client ID (creates credential inline)')
      .option('--oauth-client-secret <secret>', 'OAuth client secret (creates credential inline)')
      .option('--oauth-discovery-url <url>', 'OAuth discovery URL (creates credential inline)')
      .option('--oauth-scopes <scopes>', 'OAuth scopes, comma-separated')
      .option('--rest-api-id <id>', 'API Gateway REST API ID (required for api-gateway type)')
      .option('--stage <stage>', 'API Gateway deployment stage (required for api-gateway type)')
      .option('--tool-filter-path <path>', 'Tool filter path pattern, e.g. /pets/*')
      .option('--tool-filter-methods <methods>', 'Comma-separated HTTP methods, e.g. GET,POST')
      .option('--json', 'Output as JSON')
      .action(async (rawOptions: Record<string, string | boolean | undefined>) => {
        const cliOptions = rawOptions as unknown as CLIAddGatewayTargetOptions;
        try {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          const validation = await validateAddGatewayTargetOptions(cliOptions);
          if (!validation.valid) {
            if (cliOptions.json) {
              console.log(JSON.stringify({ success: false, error: validation.error }));
            } else {
              console.error(validation.error);
            }
            process.exit(1);
          }

          // Map CLI flag values to internal types
          const outboundAuthMap: Record<string, 'OAUTH' | 'API_KEY' | 'NONE'> = {
            oauth: 'OAUTH',
            'api-key': 'API_KEY',
            none: 'NONE',
          };

          // Handle API Gateway targets (no code generation)
          if (cliOptions.type === 'apiGateway') {
            const config: ApiGatewayTargetConfig = {
              targetType: 'apiGateway',
              name: cliOptions.name!,
              gateway: cliOptions.gateway!,
              restApiId: cliOptions.restApiId!,
              stage: cliOptions.stage!,
              toolFilters: cliOptions.toolFilterPath
                ? [
                    {
                      filterPath: cliOptions.toolFilterPath,
                      methods: (cliOptions.toolFilterMethods?.split(',').map(m => m.trim()) ?? [
                        'GET',
                      ]) as ApiGatewayHttpMethod[],
                    },
                  ]
                : undefined,
            };
            const result = await this.createApiGatewayTarget(config);
            const output = { success: true, toolName: result.toolName };
            if (cliOptions.json) {
              console.log(JSON.stringify(output));
            } else {
              console.log(`Added gateway target '${result.toolName}'`);
            }
            process.exit(0);
          }

          // Handle MCP server targets (existing endpoint, no code generation)
          if (cliOptions.type === 'mcpServer' && cliOptions.endpoint) {
            const config: McpServerTargetConfig = {
              targetType: 'mcpServer',
              name: cliOptions.name!,
              description: cliOptions.description ?? `Tool for ${cliOptions.name!}`,
              endpoint: cliOptions.endpoint,
              gateway: cliOptions.gateway!,
              toolDefinition: {
                name: cliOptions.name!,
                description: cliOptions.description ?? `Tool for ${cliOptions.name!}`,
                inputSchema: { type: 'object' },
              },
              ...(cliOptions.outboundAuthType
                ? {
                    outboundAuth: {
                      type: outboundAuthMap[cliOptions.outboundAuthType.toLowerCase()] ?? 'NONE',
                      credentialName: cliOptions.credentialName,
                    },
                  }
                : {}),
            };
            const result = await this.createExternalGatewayTarget(config);
            const output = { success: true, toolName: result.toolName, sourcePath: result.projectPath || undefined };
            if (cliOptions.json) {
              console.log(JSON.stringify(output));
            } else {
              console.log(`Added gateway target '${result.toolName}'`);
            }
            process.exit(0);
          }

          const result = await this.add({
            name: cliOptions.name!,
            description: cliOptions.description,
            language: cliOptions.language ?? 'Python',
            gateway: cliOptions.gateway,
            host: cliOptions.host,
          });

          if (cliOptions.json) {
            console.log(JSON.stringify(result));
          } else if (result.success) {
            console.log(`Added gateway target '${result.toolName}'`);
            if (result.sourcePath) {
              console.log(`Tool code: ${result.sourcePath}`);
            }
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
      .command('gateway-target', { hidden: true })
      .description('Remove a gateway target from the project')
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
                message: result.success ? `Removed gateway target '${cliOptions.name}'` : undefined,
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
   * Create an external gateway target that connects to an existing MCP server endpoint.
   * Unlike `add()` which scaffolds new code, this registers an existing endpoint URL.
   */
  async createExternalGatewayTarget(config: McpServerTargetConfig): Promise<{ toolName: string; projectPath: string }> {
    const mcpSpec: AgentCoreMcpSpec = this.configIO.configExists('mcp')
      ? await this.configIO.readMcpSpec()
      : { agentCoreGateways: [] };

    const target: AgentCoreGatewayTarget = {
      name: config.name,
      targetType: 'mcpServer',
      endpoint: config.endpoint,
      toolDefinitions: [config.toolDefinition],
      ...(config.outboundAuth && { outboundAuth: config.outboundAuth }),
    };

    if (!config.gateway) {
      throw new Error(
        "Gateway is required. A gateway target must be attached to a gateway. Create a gateway first with 'agentcore add gateway'."
      );
    }

    const gateway = mcpSpec.agentCoreGateways.find(g => g.name === config.gateway);
    if (!gateway) {
      throw new Error(`Gateway "${config.gateway}" not found.`);
    }

    // Check for duplicate target name
    if (gateway.targets.some(t => t.name === config.name)) {
      throw new Error(`Target "${config.name}" already exists in gateway "${gateway.name}".`);
    }

    gateway.targets.push(target);

    await this.configIO.writeMcpSpec(mcpSpec);

    return { toolName: config.name, projectPath: '' };
  }

  /**
   * Create an API Gateway target that connects to an existing Amazon API Gateway REST API.
   * Unlike `add()` which scaffolds new code, this registers an existing REST API.
   */
  async createApiGatewayTarget(config: ApiGatewayTargetConfig): Promise<{ toolName: string }> {
    const mcpSpec: AgentCoreMcpSpec = this.configIO.configExists('mcp')
      ? await this.configIO.readMcpSpec()
      : { agentCoreGateways: [] };

    const gateway = mcpSpec.agentCoreGateways.find(g => g.name === config.gateway);
    if (!gateway) {
      throw new Error(`Gateway "${config.gateway}" not found.`);
    }

    if (!gateway.targets) {
      gateway.targets = [];
    }

    if (gateway.targets.some(t => t.name === config.name)) {
      throw new Error(`Target "${config.name}" already exists in gateway "${gateway.name}".`);
    }

    const target: AgentCoreGatewayTarget = {
      name: config.name,
      targetType: 'apiGateway',
      apiGateway: {
        restApiId: config.restApiId,
        stage: config.stage,
        apiGatewayToolConfiguration: {
          toolFilters: config.toolFilters ?? [{ filterPath: '/*', methods: ['GET'] }],
        },
      },
    };

    gateway.targets.push(target);
    await this.configIO.writeMcpSpec(mcpSpec);

    return { toolName: config.name };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════

  private buildGatewayTargetConfig(options: AddGatewayTargetOptions): GatewayTargetWizardState {
    const sourcePath = `${APP_DIR}/${MCP_APP_SUBDIR}/${options.name}`;
    const description = options.description ?? `Tool for ${options.name}`;
    return {
      name: options.name,
      description,
      sourcePath,
      language: options.language,
      host: options.host ?? 'AgentCoreRuntime',
      toolDefinition: {
        name: options.name,
        description,
        inputSchema: { type: 'object' },
      },
      gateway: options.gateway,
    };
  }

  private async createToolFromWizard(
    config: GatewayTargetWizardState
  ): Promise<{ mcpDefsPath: string; toolName: string; projectPath: string }> {
    this.validateGatewayTargetLanguage(config.language!);

    const mcpSpec: AgentCoreMcpSpec = this.configIO.configExists('mcp')
      ? await this.configIO.readMcpSpec()
      : { agentCoreGateways: [] };

    const toolDefs =
      config.host === 'Lambda' ? getTemplateToolDefinitions(config.name, config.host) : [config.toolDefinition!];

    for (const toolDef of toolDefs) {
      ToolDefinitionSchema.parse(toolDef);
    }

    if (!config.gateway) {
      throw new Error('Gateway name is required for gateway targets.');
    }

    const gateway = mcpSpec.agentCoreGateways.find(g => g.name === config.gateway);
    if (!gateway) {
      throw new Error(`Gateway "${config.gateway}" not found.`);
    }

    if (gateway.targets.some(t => t.name === config.name)) {
      throw new Error(`Target "${config.name}" already exists in gateway "${gateway.name}".`);
    }

    for (const toolDef of toolDefs) {
      for (const existingTarget of gateway.targets) {
        if ((existingTarget.toolDefinitions ?? []).some(t => t.name === toolDef.name)) {
          throw new Error(`Tool "${toolDef.name}" already exists in gateway "${gateway.name}".`);
        }
      }
    }

    if (config.language === 'Other') {
      throw new Error('Language "Other" is not yet supported for gateway targets. Use Python or TypeScript.');
    }

    const target: AgentCoreGatewayTarget = {
      name: config.name,
      targetType: config.host === 'AgentCoreRuntime' ? 'mcpServer' : 'lambda',
      toolDefinitions: toolDefs,
      compute:
        config.host === 'Lambda'
          ? {
              host: 'Lambda',
              implementation: {
                path: config.sourcePath!,
                language: config.language,
                handler: DEFAULT_HANDLER,
              },
              ...(config.language === 'Python'
                ? { pythonVersion: DEFAULT_PYTHON_VERSION }
                : { nodeVersion: DEFAULT_NODE_VERSION }),
            }
          : {
              host: 'AgentCoreRuntime',
              implementation: {
                path: config.sourcePath!,
                language: 'Python',
                handler: 'server.py:main',
              },
              runtime: {
                artifact: 'CodeZip',
                pythonVersion: DEFAULT_PYTHON_VERSION,
                name: config.name,
                entrypoint: 'server.py:main' as FilePath,
                codeLocation: config.sourcePath! as DirectoryPath,
                networkMode: 'PUBLIC',
              },
            },
    };

    gateway.targets.push(target);
    await this.configIO.writeMcpSpec(mcpSpec);

    // Update mcp-defs.json
    const mcpDefsPath = this.resolveMcpDefsPath();
    try {
      const mcpDefs = await this.readMcpDefs(mcpDefsPath);
      for (const toolDef of toolDefs) {
        if (mcpDefs.tools[toolDef.name]) {
          throw new Error(`Tool definition "${toolDef.name}" already exists in mcp-defs.json.`);
        }
        mcpDefs.tools[toolDef.name] = toolDef;
      }
      await this.writeMcpDefs(mcpDefsPath, mcpDefs);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new Error(`MCP saved, but failed to update mcp-defs.json: ${message}`);
    }

    // Render gateway target project template
    const configRoot = requireConfigRoot();
    const projectRoot = dirname(configRoot);
    const absoluteSourcePath = join(projectRoot, config.sourcePath!);
    await renderGatewayTargetTemplate(config.name, absoluteSourcePath, config.language, config.host);

    return { mcpDefsPath, toolName: config.name, projectPath: config.sourcePath! };
  }

  private validateGatewayTargetLanguage(language: string): asserts language is 'Python' | 'TypeScript' | 'Other' {
    if (language !== 'Python' && language !== 'TypeScript' && language !== 'Other') {
      throw new Error(`Gateway targets for language "${language}" are not yet supported.`);
    }
  }

  private resolveMcpDefsPath(): string {
    return join(requireConfigRoot(), MCP_DEFS_FILE);
  }

  private async readMcpDefs(filePath: string): Promise<AgentCoreCliMcpDefs> {
    if (!existsSync(filePath)) {
      return { tools: {} };
    }

    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const result = AgentCoreCliMcpDefsSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error('Invalid mcp-defs.json. Fix it before adding a new gateway target.');
    }
    return result.data;
  }

  private async writeMcpDefs(filePath: string, data: AgentCoreCliMcpDefs): Promise<void> {
    const configRoot = requireConfigRoot();
    await mkdir(configRoot, { recursive: true });
    const content = JSON.stringify(data, null, 2);
    await writeFile(filePath, content, 'utf-8');
  }

  private computeRemovedToolMcpSpec(mcpSpec: AgentCoreMcpSpec, tool: RemovableGatewayTarget): AgentCoreMcpSpec {
    return {
      ...mcpSpec,
      agentCoreGateways: mcpSpec.agentCoreGateways.map(g => {
        if (g.name !== tool.gatewayName) return g;
        return {
          ...g,
          targets: g.targets.filter(t => t.name !== tool.name),
        };
      }),
    };
  }

  private computeRemovedToolMcpDefs(
    mcpSpec: AgentCoreMcpSpec,
    mcpDefs: AgentCoreCliMcpDefs,
    tool: RemovableGatewayTarget
  ): AgentCoreCliMcpDefs {
    const toolNamesToRemove: string[] = [];

    const gateway = mcpSpec.agentCoreGateways.find(g => g.name === tool.gatewayName);
    const target = gateway?.targets.find(t => t.name === tool.name);
    if (target) {
      for (const toolDef of target.toolDefinitions ?? []) {
        toolNamesToRemove.push(toolDef.name);
      }
    }

    const newTools = { ...mcpDefs.tools };
    for (const name of toolNamesToRemove) {
      delete newTools[name];
    }

    return { ...mcpDefs, tools: newTools };
  }
}
