import { ConfigIO } from '../../../lib';
import type { AgentCoreCliMcpDefs, AgentCoreMcpSpec } from '../../../schema';
import type { RemovalPreview, RemovalResult, SchemaChange } from './types';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';

/**
 * Represents an MCP tool that can be removed.
 */
export interface RemovableMcpTool {
  name: string;
  type: 'mcp-runtime' | 'gateway-target';
  gatewayName?: string;
}

/**
 * Get list of MCP tools available for removal.
 */
export async function getRemovableMcpTools(): Promise<RemovableMcpTool[]> {
  try {
    const configIO = new ConfigIO();
    if (!configIO.configExists('mcp')) {
      return [];
    }
    const mcpSpec = await configIO.readMcpSpec();
    const tools: RemovableMcpTool[] = [];

    // MCP Runtime tools
    for (const tool of mcpSpec.mcpRuntimeTools ?? []) {
      tools.push({ name: tool.name, type: 'mcp-runtime' });
    }

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
 * Compute the preview of what will be removed when removing an MCP tool.
 */
export async function previewRemoveMcpTool(tool: RemovableMcpTool): Promise<RemovalPreview> {
  const configIO = new ConfigIO();
  const mcpSpec = await configIO.readMcpSpec();
  const mcpDefs = configIO.configExists('mcpDefs') ? await configIO.readMcpDefs() : { tools: {} };

  const summary: string[] = [];
  const directoriesToDelete: string[] = [];
  const schemaChanges: SchemaChange[] = [];
  const projectRoot = configIO.getProjectRoot();

  if (tool.type === 'mcp-runtime') {
    const mcpTool = mcpSpec.mcpRuntimeTools?.find(t => t.name === tool.name);
    if (!mcpTool) {
      throw new Error(`MCP Runtime tool "${tool.name}" not found.`);
    }

    summary.push(`Removing MCP Runtime tool: ${tool.name}`);

    // Check for directory to delete
    const implementation = mcpTool.compute.implementation;
    const toolPath = 'path' in implementation ? implementation.path : undefined;
    if (toolPath) {
      const toolDir = join(projectRoot, toolPath);
      if (existsSync(toolDir)) {
        directoriesToDelete.push(toolDir);
        summary.push(`Deleting directory: ${toolPath}`);
      }
    }

    // Tool definition in mcp-defs
    if (mcpDefs.tools[mcpTool.toolDefinition.name]) {
      summary.push(`Removing tool definition: ${mcpTool.toolDefinition.name}`);
    }
  } else {
    // Gateway target
    const gateway = mcpSpec.agentCoreGateways.find(g => g.name === tool.gatewayName);
    if (!gateway) {
      throw new Error(`Gateway "${tool.gatewayName}" not found.`);
    }

    const target = gateway.targets.find(t => t.name === tool.name);
    if (!target) {
      throw new Error(`Target "${tool.name}" not found in gateway "${tool.gatewayName}".`);
    }

    summary.push(`Removing gateway target: ${tool.name} (from ${tool.gatewayName})`);

    // Check for directory to delete
    if (target.compute?.implementation && 'path' in target.compute.implementation) {
      const toolPath = target.compute.implementation.path;
      const toolDir = join(projectRoot, toolPath);
      if (existsSync(toolDir)) {
        directoriesToDelete.push(toolDir);
        summary.push(`Deleting directory: ${toolPath}`);
      }
    }

    // Tool definitions in mcp-defs
    for (const toolDef of target.toolDefinitions) {
      if (mcpDefs.tools[toolDef.name]) {
        summary.push(`Removing tool definition: ${toolDef.name}`);
      }
    }
  }

  // Compute schema changes
  const afterMcpSpec = computeRemovedToolMcpSpec(mcpSpec, tool);
  schemaChanges.push({
    file: 'agentcore/mcp.json',
    before: mcpSpec,
    after: afterMcpSpec,
  });

  const afterMcpDefs = computeRemovedToolMcpDefs(mcpSpec, mcpDefs, tool);
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
 * Compute the MCP spec after removing a tool.
 */
function computeRemovedToolMcpSpec(mcpSpec: AgentCoreMcpSpec, tool: RemovableMcpTool): AgentCoreMcpSpec {
  if (tool.type === 'mcp-runtime') {
    return {
      ...mcpSpec,
      mcpRuntimeTools: (mcpSpec.mcpRuntimeTools ?? []).filter(t => t.name !== tool.name),
    };
  }

  // Gateway target
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

/**
 * Compute the MCP defs after removing a tool.
 */
function computeRemovedToolMcpDefs(
  mcpSpec: AgentCoreMcpSpec,
  mcpDefs: AgentCoreCliMcpDefs,
  tool: RemovableMcpTool
): AgentCoreCliMcpDefs {
  const toolNamesToRemove: string[] = [];

  if (tool.type === 'mcp-runtime') {
    const mcpTool = mcpSpec.mcpRuntimeTools?.find(t => t.name === tool.name);
    if (mcpTool) {
      toolNamesToRemove.push(mcpTool.toolDefinition.name);
    }
  } else {
    const gateway = mcpSpec.agentCoreGateways.find(g => g.name === tool.gatewayName);
    const target = gateway?.targets.find(t => t.name === tool.name);
    if (target) {
      for (const toolDef of target.toolDefinitions) {
        toolNamesToRemove.push(toolDef.name);
      }
    }
  }

  const newTools = { ...mcpDefs.tools };
  for (const name of toolNamesToRemove) {
    delete newTools[name];
  }

  return { ...mcpDefs, tools: newTools };
}

/**
 * Remove an MCP tool from the project.
 */
export async function removeMcpTool(tool: RemovableMcpTool): Promise<RemovalResult> {
  try {
    const configIO = new ConfigIO();
    const mcpSpec = await configIO.readMcpSpec();
    const mcpDefs = configIO.configExists('mcpDefs') ? await configIO.readMcpDefs() : { tools: {} };
    const projectRoot = configIO.getProjectRoot();

    // Find the tool path for deletion
    let toolPath: string | undefined;

    if (tool.type === 'mcp-runtime') {
      const mcpTool = mcpSpec.mcpRuntimeTools?.find(t => t.name === tool.name);
      if (!mcpTool) {
        return { ok: false, error: `MCP Runtime tool "${tool.name}" not found.` };
      }
      const impl = mcpTool.compute.implementation;
      toolPath = 'path' in impl ? impl.path : undefined;
    } else {
      const gateway = mcpSpec.agentCoreGateways.find(g => g.name === tool.gatewayName);
      if (!gateway) {
        return { ok: false, error: `Gateway "${tool.gatewayName}" not found.` };
      }
      const target = gateway.targets.find(t => t.name === tool.name);
      if (!target) {
        return { ok: false, error: `Target "${tool.name}" not found in gateway "${tool.gatewayName}".` };
      }
      if (target.compute?.implementation && 'path' in target.compute.implementation) {
        toolPath = target.compute.implementation.path;
      }
    }

    // Update MCP spec
    const newMcpSpec = computeRemovedToolMcpSpec(mcpSpec, tool);
    await configIO.writeMcpSpec(newMcpSpec);

    // Update MCP defs
    const newMcpDefs = computeRemovedToolMcpDefs(mcpSpec, mcpDefs, tool);
    await configIO.writeMcpDefs(newMcpDefs);

    // Delete tool directory if it exists
    if (toolPath) {
      const toolDir = join(projectRoot, toolPath);
      if (existsSync(toolDir)) {
        await rm(toolDir, { recursive: true, force: true });
      }
    }

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: message };
  }
}
