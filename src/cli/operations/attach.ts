import { ConfigIO } from '../../lib';
import type { McpRuntimeBinding } from '../../schema';

// ─────────────────────────────────────────────────────────────────────────────
// Data Loading Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get list of agent names from project spec.
 */
export async function getAvailableAgents(): Promise<string[]> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();
    return project.agents.map(agent => agent.name);
  } catch {
    return [];
  }
}

/**
 * Get list of memory names from project spec.
 */
export async function getMemories(): Promise<string[]> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();
    return project.memories.map(m => m.name);
  } catch {
    return [];
  }
}

/**
 * Get list of credential names from project spec.
 */
export async function getCredentials(): Promise<string[]> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();
    return project.credentials.map(c => c.name);
  } catch {
    return [];
  }
}

/**
 * Get list of MCP runtime tools from mcp.json.
 */
export async function getMcpRuntimeTools(): Promise<string[]> {
  try {
    const configIO = new ConfigIO();
    const mcpSpec = await configIO.readMcpSpec();
    if (!mcpSpec?.mcpRuntimeTools) return [];
    return mcpSpec.mcpRuntimeTools.map(tool => tool.name);
  } catch {
    return [];
  }
}

/**
 * Get list of gateways from mcp.json.
 */
export async function getGateways(): Promise<string[]> {
  try {
    const configIO = new ConfigIO();
    const mcpSpec = await configIO.readMcpSpec();
    if (!mcpSpec?.agentCoreGateways) return [];
    return mcpSpec.agentCoreGateways.map(gw => gw.name);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Binding Functions
// ─────────────────────────────────────────────────────────────────────────────

export interface BindMcpRuntimeConfig {
  agentName: string;
  envVarName: string;
}

/**
 * Bind an agent to an MCP runtime tool.
 * Adds the binding to the MCP runtime's bindings array in mcp.json.
 */
export async function bindMcpRuntimeToAgent(mcpRuntimeName: string, config: BindMcpRuntimeConfig): Promise<void> {
  const configIO = new ConfigIO();

  // Validate the agent exists
  const project = await configIO.readProjectSpec();
  const agent = project.agents.find(a => a.name === config.agentName);
  if (!agent) {
    throw new Error(`Agent "${config.agentName}" not found.`);
  }

  // Find the MCP runtime tool
  const mcpSpec = await configIO.readMcpSpec();
  const runtimeTool = mcpSpec.mcpRuntimeTools?.find(t => t.name === mcpRuntimeName);
  if (!runtimeTool) {
    throw new Error(`MCP runtime tool "${mcpRuntimeName}" not found in mcp.json.`);
  }

  // Initialize bindings array if needed
  runtimeTool.bindings ??= [];

  // Check if already bound
  if (runtimeTool.bindings.some(b => b.agentName === config.agentName)) {
    throw new Error(`Agent "${config.agentName}" is already bound to MCP runtime "${mcpRuntimeName}".`);
  }

  const binding: McpRuntimeBinding = {
    agentName: config.agentName,
    envVarName: config.envVarName,
  };

  runtimeTool.bindings.push(binding);
  await configIO.writeMcpSpec(mcpSpec);
}
