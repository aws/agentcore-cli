import { ConfigIO } from '../../../lib';
import { getErrorMessage } from '../../errors';
import {
  getRemovableMcpTools,
  removeAgent,
  removeGateway,
  removeIdentity,
  removeMcpTool,
  removeMemory,
  removeTarget,
} from '../../operations/remove';
import type { RemoveAllOptions, RemoveResult, ResourceType } from './types';

export interface ValidatedRemoveOptions {
  resourceType: ResourceType;
  name: string;
  force?: boolean;
}

export async function handleRemove(options: ValidatedRemoveOptions): Promise<RemoveResult> {
  const { resourceType, name } = options;

  try {
    switch (resourceType) {
      case 'agent': {
        const result = await removeAgent(name);
        if (!result.ok) return { success: false, error: result.error };
        return { success: true, resourceType, resourceName: name, message: `Removed agent '${name}'` };
      }
      case 'gateway': {
        const result = await removeGateway(name);
        if (!result.ok) return { success: false, error: result.error };
        return { success: true, resourceType, resourceName: name, message: `Removed gateway '${name}'` };
      }
      case 'mcp-tool': {
        const tools = await getRemovableMcpTools();
        const tool = tools.find(t => t.name === name);
        if (!tool) return { success: false, error: `MCP tool '${name}' not found` };
        const result = await removeMcpTool(tool);
        if (!result.ok) return { success: false, error: result.error };
        return { success: true, resourceType, resourceName: name, message: `Removed MCP tool '${name}'` };
      }
      case 'memory': {
        const result = await removeMemory(name);
        if (!result.ok) return { success: false, error: result.error };
        return { success: true, resourceType, resourceName: name, message: `Removed memory '${name}'` };
      }
      case 'identity': {
        const result = await removeIdentity(name);
        if (!result.ok) return { success: false, error: result.error };
        return { success: true, resourceType, resourceName: name, message: `Removed identity '${name}'` };
      }
      case 'target': {
        const result = await removeTarget(name);
        if (!result.ok) return { success: false, error: result.error };
        return { success: true, resourceType, resourceName: name, message: `Removed target '${name}'` };
      }
      default:
        return { success: false, error: `Unknown resource type: ${resourceType as string}` };
    }
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}

export async function handleRemoveAll(_options: RemoveAllOptions): Promise<RemoveResult> {
  try {
    const configIO = new ConfigIO();

    // Get current project name to preserve it
    let projectName = 'Project';
    try {
      const current = await configIO.readProjectSpec();
      projectName = current.name;
    } catch {
      // Use default if can't read
    }

    // Reset agentcore.json (keep project name)
    await configIO.writeProjectSpec({
      name: projectName,
      version: 1,
      agents: [],
      memories: [],
      credentials: [],
    });

    // Reset aws-targets.json
    await configIO.writeAWSDeploymentTargets([]);

    // Reset deployed-state.json
    await configIO.writeDeployedState({ targets: {} });

    // Reset mcp.json
    await configIO.writeMcpSpec({
      agentCoreGateways: [],
      mcpRuntimeTools: [],
    });

    // Reset mcp-defs.json
    await configIO.writeMcpDefs({ tools: {} });

    return { success: true, message: 'All schemas reset to empty state' };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}
