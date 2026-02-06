import type { SelectableItem } from '../../components';
import { SelectScreen } from '../../components';
import { useMemo } from 'react';

const REMOVE_RESOURCES = [
  { id: 'agent', title: 'Agent', description: 'Remove an agent from the project' },
  { id: 'memory', title: 'Memory', description: 'Remove a memory provider' },
  { id: 'identity', title: 'Identity', description: 'Remove an identity provider' },
  { id: 'target', title: 'Target', description: 'Remove an AWS deployment target' },
  { id: 'gateway', title: 'Gateway (coming soon)', description: 'Remove an MCP gateway', disabled: true },
  { id: 'mcp-tool', title: 'MCP Tool (coming soon)', description: 'Remove an MCP tool', disabled: true },
  { id: 'all', title: 'All', description: 'Reset entire agentcore project' },
] as const;

export type RemoveResourceType = (typeof REMOVE_RESOURCES)[number]['id'];

interface RemoveScreenProps {
  onSelect: (resourceType: RemoveResourceType) => void;
  onExit: () => void;
  /** Number of agents available for removal */
  agentCount: number;
  /** Number of gateways available for removal */
  gatewayCount: number;
  /** Number of MCP tools available for removal */
  mcpToolCount: number;
  /** Number of memories available for removal */
  memoryCount: number;
  /** Number of identities available for removal */
  identityCount: number;
  /** Number of targets available for removal */
  targetCount: number;
}

export function RemoveScreen({
  onSelect,
  onExit,
  agentCount,
  // Gateway disabled - prefix with underscore until feature is re-enabled
  gatewayCount: _gatewayCount,
  // MCP Tool disabled - prefix with underscore until feature is re-enabled
  mcpToolCount: _mcpToolCount,
  memoryCount,
  identityCount,
  targetCount,
}: RemoveScreenProps) {
  const items: SelectableItem[] = useMemo(() => {
    return REMOVE_RESOURCES.map(r => {
      let disabled = ('disabled' in r && r.disabled) || false;
      let description: string = r.description;

      switch (r.id) {
        case 'agent':
          if (agentCount === 0) {
            disabled = true;
            description = 'No agents to remove';
          }
          break;
        case 'memory':
          if (memoryCount === 0) {
            disabled = true;
            description = 'No memories to remove';
          }
          break;
        case 'identity':
          if (identityCount === 0) {
            disabled = true;
            description = 'No identities to remove';
          }
          break;
        case 'target':
          if (targetCount === 0) {
            disabled = true;
            description = 'No targets to remove';
          }
          break;
        case 'all':
          // 'all' is always available
          break;
      }

      return { ...r, disabled, description };
    });
  }, [agentCount, memoryCount, identityCount, targetCount]);

  const isDisabled = (item: SelectableItem) => item.disabled ?? false;

  return (
    <SelectScreen
      title="Remove Resource"
      items={items}
      onSelect={item => onSelect(item.id as RemoveResourceType)}
      onExit={onExit}
      isDisabled={isDisabled}
    />
  );
}
