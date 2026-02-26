import { ConfigIO } from '../../../lib';
import type { AgentCoreCliMcpDefs, AgentCoreMcpSpec } from '../../../schema';
import type { RemovalPreview, RemovalResult, SchemaChange } from './types';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';

/**
 * Represents a gateway target that can be removed.
 */
export interface RemovableGatewayTarget {
  name: string;
  type: 'gateway-target';
  gatewayName?: string;
}

/**
 * Get list of gateway targets available for removal.
 */
export async function getRemovableGatewayTargets(): Promise<RemovableGatewayTarget[]> {
  try {
    const configIO = new ConfigIO();
    if (!configIO.configExists('mcp')) {
      return [];
    }
    const mcpSpec = await configIO.readMcpSpec();
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
 * Compute the preview of what will be removed when removing a gateway target.
 */
export async function previewRemoveGatewayTarget(tool: RemovableGatewayTarget): Promise<RemovalPreview> {
  const configIO = new ConfigIO();
  const mcpSpec = await configIO.readMcpSpec();
  const mcpDefs = configIO.configExists('mcpDefs') ? await configIO.readMcpDefs() : { tools: {} };

  const summary: string[] = [];
  const directoriesToDelete: string[] = [];
  const schemaChanges: SchemaChange[] = [];
  const projectRoot = configIO.getProjectRoot();

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
  for (const toolDef of target.toolDefinitions ?? []) {
    if (mcpDefs.tools[toolDef.name]) {
      summary.push(`Removing tool definition: ${toolDef.name}`);
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
function computeRemovedToolMcpSpec(mcpSpec: AgentCoreMcpSpec, tool: RemovableGatewayTarget): AgentCoreMcpSpec {
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

/**
 * Remove a gateway target from the project.
 */
export async function removeGatewayTarget(tool: RemovableGatewayTarget): Promise<RemovalResult> {
  try {
    const configIO = new ConfigIO();
    const mcpSpec = await configIO.readMcpSpec();
    const mcpDefs = configIO.configExists('mcpDefs') ? await configIO.readMcpDefs() : { tools: {} };
    const projectRoot = configIO.getProjectRoot();

    // Find the tool path for deletion
    let toolPath: string | undefined;

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
