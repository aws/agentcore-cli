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

const SOURCE_CODE_NOTE =
  'Your agent app source code has not been modified. Deploy with `agentcore deploy` to apply your removal changes to AWS.';

export async function handleRemove(options: ValidatedRemoveOptions): Promise<RemoveResult> {
  const { resourceType, name } = options;

  try {
    switch (resourceType) {
      case 'agent': {
        const result = await removeAgent(name);
        if (!result.ok) return { success: false, error: result.error };
        return {
          success: true,
          resourceType,
          resourceName: name,
          message: `Removed agent '${name}'`,
          note: SOURCE_CODE_NOTE,
        };
      }
      case 'gateway': {
        const result = await removeGateway(name);
        if (!result.ok) return { success: false, error: result.error };
        return {
          success: true,
          resourceType,
          resourceName: name,
          message: `Removed gateway '${name}'`,
          note: SOURCE_CODE_NOTE,
        };
      }
      case 'mcp-tool': {
        const tools = await getRemovableMcpTools();
        const tool = tools.find(t => t.name === name);
        if (!tool) return { success: false, error: `MCP tool '${name}' not found` };
        const result = await removeMcpTool(tool);
        if (!result.ok) return { success: false, error: result.error };
        return {
          success: true,
          resourceType,
          resourceName: name,
          message: `Removed MCP tool '${name}'`,
          note: SOURCE_CODE_NOTE,
        };
      }
      case 'memory': {
        const result = await removeMemory(name);
        if (!result.ok) return { success: false, error: result.error };
        return {
          success: true,
          resourceType,
          resourceName: name,
          message: `Removed memory '${name}'`,
          note: SOURCE_CODE_NOTE,
        };
      }
      case 'identity': {
        const result = await removeIdentity(name);
        if (!result.ok) return { success: false, error: result.error };
        return {
          success: true,
          resourceType,
          resourceName: name,
          message: `Removed identity '${name}'`,
          note: SOURCE_CODE_NOTE,
        };
      }
      case 'target': {
        const result = await removeTarget(name);
        if (!result.ok) return { success: false, error: result.error };
        return {
          success: true,
          resourceType,
          resourceName: name,
          message: `Removed target '${name}'`,
          note: SOURCE_CODE_NOTE,
        };
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

    // Preserve aws-targets.json and deployed-state.json so that
    // a subsequent `agentcore deploy` can tear down existing stacks.

    // Reset mcp.json
    await configIO.writeMcpSpec({
      agentCoreGateways: [],
      mcpRuntimeTools: [],
    });

    // Reset mcp-defs.json
    await configIO.writeMcpDefs({ tools: {} });

    return {
      success: true,
      message: 'All schemas reset to empty state',
      note: 'Your source code has not been modified. Run `agentcore deploy` to apply changes to AWS.',
    };
  } catch (err) {
    return { success: false, error: getErrorMessage(err) };
  }
}
