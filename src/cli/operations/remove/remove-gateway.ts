import { ConfigIO } from '../../../lib';
import type { AgentCoreMcpSpec } from '../../../schema';
import type { RemovalPreview, RemovalResult, SchemaChange } from './types';

/**
 * Get list of gateways available for removal.
 */
export async function getRemovableGateways(): Promise<string[]> {
  try {
    const configIO = new ConfigIO();
    if (!configIO.configExists('mcp')) {
      return [];
    }
    const mcpSpec = await configIO.readMcpSpec();
    return mcpSpec.agentCoreGateways.map(g => g.name);
  } catch {
    return [];
  }
}

/**
 * Compute the preview of what will be removed when removing a gateway.
 */
export async function previewRemoveGateway(gatewayName: string): Promise<RemovalPreview> {
  const configIO = new ConfigIO();
  const mcpSpec = await configIO.readMcpSpec();

  const gateway = mcpSpec.agentCoreGateways.find(g => g.name === gatewayName);
  if (!gateway) {
    throw new Error(`Gateway "${gatewayName}" not found.`);
  }

  const summary: string[] = [`Removing gateway: ${gatewayName}`];
  const schemaChanges: SchemaChange[] = [];

  if (gateway.targets.length > 0) {
    summary.push(`Note: ${gateway.targets.length} target(s) behind this gateway will become orphaned`);
  }

  // Compute schema changes
  const afterMcpSpec = computeRemovedGatewayMcpSpec(mcpSpec, gatewayName);
  schemaChanges.push({
    file: 'agentcore/mcp.json',
    before: mcpSpec,
    after: afterMcpSpec,
  });

  return { summary, directoriesToDelete: [], schemaChanges };
}

/**
 * Compute the MCP spec after removing a gateway.
 */
function computeRemovedGatewayMcpSpec(mcpSpec: AgentCoreMcpSpec, gatewayName: string): AgentCoreMcpSpec {
  return {
    ...mcpSpec,
    agentCoreGateways: mcpSpec.agentCoreGateways.filter(g => g.name !== gatewayName),
  };
}

/**
 * Remove a gateway from the project.
 */
export async function removeGateway(gatewayName: string): Promise<RemovalResult> {
  try {
    const configIO = new ConfigIO();
    const mcpSpec = await configIO.readMcpSpec();

    const gateway = mcpSpec.agentCoreGateways.find(g => g.name === gatewayName);
    if (!gateway) {
      return { ok: false, error: `Gateway "${gatewayName}" not found.` };
    }

    // Remove gateway from MCP spec
    const newMcpSpec = computeRemovedGatewayMcpSpec(mcpSpec, gatewayName);
    await configIO.writeMcpSpec(newMcpSpec);

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return { ok: false, error: message };
  }
}
