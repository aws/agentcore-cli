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
    return project.runtimes.map(agent => agent.name);
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
 * Get list of MCP runtime tools from agentcore.json.
 */
export async function getMcpRuntimeTools(): Promise<string[]> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();
    if (!project?.mcpRuntimeTools) return [];
    return project.mcpRuntimeTools.map(tool => tool.name);
  } catch {
    return [];
  }
}

/**
 * Get list of gateways from agentcore.json.
 */
export async function getGateways(): Promise<string[]> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();
    return project.agentCoreGateways.map(gw => gw.name);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP Binding Functions
// ─────────────────────────────────────────────────────────────────────────────

export interface BindMcpRuntimeConfig {
  runtimeName: string;
  envVarName: string;
}

/**
 * Bind an agent to an MCP runtime tool.
 * Adds the binding to the MCP runtime's bindings array in agentcore.json.
 */
export async function bindMcpRuntimeToAgent(mcpRuntimeName: string, config: BindMcpRuntimeConfig): Promise<void> {
  const configIO = new ConfigIO();

  // Validate the runtime exists
  const project = await configIO.readProjectSpec();
  const agent = project.runtimes.find(a => a.name === config.runtimeName);
  if (!agent) {
    throw new Error(`Runtime "${config.runtimeName}" not found.`);
  }

  // Find the MCP runtime tool
  const runtimeTool = project.mcpRuntimeTools?.find(t => t.name === mcpRuntimeName);
  if (!runtimeTool) {
    throw new Error(`MCP runtime tool "${mcpRuntimeName}" not found in agentcore.json.`);
  }

  // Initialize bindings array if needed
  runtimeTool.bindings ??= [];

  // Check if already bound
  if (runtimeTool.bindings.some(b => b.runtimeName === config.runtimeName)) {
    throw new Error(`Runtime "${config.runtimeName}" is already bound to MCP runtime "${mcpRuntimeName}".`);
  }

  const binding: McpRuntimeBinding = {
    runtimeName: config.runtimeName,
    envVarName: config.envVarName,
  };

  runtimeTool.bindings.push(binding);
  await configIO.writeProjectSpec(project);
}
