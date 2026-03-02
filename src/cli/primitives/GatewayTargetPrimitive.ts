import { APP_DIR, MCP_APP_SUBDIR, requireConfigRoot } from '../../lib';
import type {
  AgentCoreCliMcpDefs,
  AgentCoreGatewayTarget,
  AgentCoreMcpSpec,
  DirectoryPath,
  FilePath,
} from '../../schema';
import { AgentCoreCliMcpDefsSchema, AgentCoreGatewayTargetSchema, ToolDefinitionSchema } from '../../schema';
import { getErrorMessage } from '../errors';
import type { RemovableGatewayTarget } from '../operations/remove/remove-gateway-target';
import type { RemovalPreview, RemovalResult, SchemaChange } from '../operations/remove/types';
import { getTemplateToolDefinitions, renderGatewayTargetTemplate } from '../templates/GatewayTargetRenderer';
import type { AddGatewayTargetConfig } from '../tui/screens/mcp/types';
import { DEFAULT_HANDLER, DEFAULT_NODE_VERSION, DEFAULT_PYTHON_VERSION } from '../tui/screens/mcp/types';
import { BasePrimitive } from './BasePrimitive';
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
      .option('--language <lang>', 'Language: Python, TypeScript, Other')
      .option('--gateway <name>', 'Gateway name')
      .option('--host <host>', 'Host type: Lambda or AgentCoreRuntime')
      .option('--json', 'Output as JSON')
      .action(() => {
        console.error('Gateway target integration is coming soon.');
        process.exit(1);
      });

    removeCmd
      .command('gateway-target', { hidden: true })
      .description('Remove a gateway target from the project')
      .option('--name <name>', 'Name of resource to remove')
      .option('--force', 'Skip confirmation prompt')
      .option('--json', 'Output as JSON')
      .action(() => {
        console.error('Gateway target integration is coming soon.');
        process.exit(1);
      });
  }

  addScreen(): AddScreenComponent {
    return null;
  }

  /**
   * Create an external gateway target that connects to an existing MCP server endpoint.
   * Unlike `add()` which scaffolds new code, this registers an existing endpoint URL.
   */
  async createExternalGatewayTarget(
    config: AddGatewayTargetConfig
  ): Promise<{ toolName: string; projectPath: string }> {
    if (!config.endpoint) {
      throw new Error('Endpoint URL is required for external MCP server targets.');
    }

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

  // ═══════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════

  private buildGatewayTargetConfig(options: AddGatewayTargetOptions): AddGatewayTargetConfig {
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
    config: AddGatewayTargetConfig
  ): Promise<{ mcpDefsPath: string; toolName: string; projectPath: string }> {
    this.validateGatewayTargetLanguage(config.language);

    const mcpSpec: AgentCoreMcpSpec = this.configIO.configExists('mcp')
      ? await this.configIO.readMcpSpec()
      : { agentCoreGateways: [] };

    const toolDefs =
      config.host === 'Lambda' ? getTemplateToolDefinitions(config.name, config.host) : [config.toolDefinition];

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
                path: config.sourcePath,
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
                path: config.sourcePath,
                language: 'Python',
                handler: 'server.py:main',
              },
              runtime: {
                artifact: 'CodeZip',
                pythonVersion: DEFAULT_PYTHON_VERSION,
                name: config.name,
                entrypoint: 'server.py:main' as FilePath,
                codeLocation: config.sourcePath as DirectoryPath,
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
    const absoluteSourcePath = join(projectRoot, config.sourcePath);
    await renderGatewayTargetTemplate(config.name, absoluteSourcePath, config.language, config.host);

    return { mcpDefsPath, toolName: config.name, projectPath: config.sourcePath };
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
