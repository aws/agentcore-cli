import { ConfigIO } from '../../../lib';
import { getErrorMessage } from '../../errors';
import {
  getRemovableMcpTools,
  previewRemoveAgent,
  previewRemoveGateway,
  previewRemoveIdentity,
  previewRemoveMcpTool,
  previewRemoveMemory,
  previewRemoveTarget,
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
        const preview = await previewRemoveAgent(name);
        if (preview.blockers && preview.blockers.length > 0) {
          const blockerMsg = preview.blockers
            .map(b => `${b.resourceType} '${b.resourceName}' has dependents: ${b.dependents.join(', ')}`)
            .join('; ');
          return { success: false, error: `Cannot remove agent: ${blockerMsg}` };
        }
        const result = await removeAgent(name);
        if (!result.ok) return { success: false, error: result.error };
        return { success: true, resourceType, resourceName: name, message: `Removed agent '${name}'` };
      }
      case 'gateway': {
        const preview = await previewRemoveGateway(name);
        if (preview.blockers && preview.blockers.length > 0) {
          return { success: false, error: 'Cannot remove gateway: has blockers' };
        }
        const result = await removeGateway(name);
        if (!result.ok) return { success: false, error: result.error };
        return { success: true, resourceType, resourceName: name, message: `Removed gateway '${name}'` };
      }
      case 'mcp-tool': {
        const tools = await getRemovableMcpTools();
        const tool = tools.find(t => t.name === name);
        if (!tool) return { success: false, error: `MCP tool '${name}' not found` };
        const preview = await previewRemoveMcpTool(tool);
        if (preview.blockers && preview.blockers.length > 0) {
          return { success: false, error: 'Cannot remove MCP tool: has blockers' };
        }
        const result = await removeMcpTool(tool);
        if (!result.ok) return { success: false, error: result.error };
        return { success: true, resourceType, resourceName: name, message: `Removed MCP tool '${name}'` };
      }
      case 'memory': {
        const preview = await previewRemoveMemory(name);
        if (preview.blockers && preview.blockers.length > 0) {
          return { success: false, error: 'Cannot remove memory: has blockers' };
        }
        const result = await removeMemory(name);
        if (!result.ok) return { success: false, error: result.error };
        return { success: true, resourceType, resourceName: name, message: `Removed memory '${name}'` };
      }
      case 'identity': {
        const preview = await previewRemoveIdentity(name);
        if (preview.blockers && preview.blockers.length > 0) {
          return { success: false, error: 'Cannot remove identity: has blockers' };
        }
        const result = await removeIdentity(name);
        if (!result.ok) return { success: false, error: result.error };
        return { success: true, resourceType, resourceName: name, message: `Removed identity '${name}'` };
      }
      case 'target': {
        const preview = await previewRemoveTarget(name);
        if (preview.blockers && preview.blockers.length > 0) {
          return { success: false, error: 'Cannot remove target: has blockers' };
        }
        const result = await removeTarget(name);
        if (!result.ok) return { success: false, error: result.error };
        return { success: true, resourceType, resourceName: name, message: `Removed target '${name}'` };
      }
      default:
        return { success: false, error: `Unknown resource type: ${resourceType}` };
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
      version: '0.1',
      description: `AgentCore project: ${projectName}`,
      agents: [],
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
