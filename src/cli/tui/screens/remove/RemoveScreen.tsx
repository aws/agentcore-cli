import type { SelectableItem } from '../../components';
import { SelectScreen } from '../../components';
import { useMemo } from 'react';

const REMOVE_RESOURCES = [
  { id: 'agent', title: 'Agent', description: 'Remove an agent from the project' },
  { id: 'memory', title: 'Memory', description: 'Remove a memory provider' },
  { id: 'identity', title: 'Identity', description: 'Remove an identity provider' },
  { id: 'gateway', title: 'Gateway', description: 'Remove a gateway' },
  { id: 'gateway-target', title: 'Gateway Target', description: 'Remove a gateway target' },
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
  /** Number of gateway targets available for removal */
  mcpToolCount: number;
  /** Number of memories available for removal */
  memoryCount: number;
  /** Number of identities available for removal */
  identityCount: number;
}

export function RemoveScreen({
  onSelect,
  onExit,
  agentCount,
  gatewayCount,
  mcpToolCount,
  memoryCount,
  identityCount,
}: RemoveScreenProps) {
  const items: SelectableItem[] = useMemo(() => {
    return REMOVE_RESOURCES.map(r => {
      let disabled = Boolean('disabled' in r && r.disabled);
      let description: string = r.description;

      switch (r.id) {
        case 'agent':
          if (agentCount === 0) {
            disabled = true;
            description = 'No agents to remove';
          }
          break;
        case 'gateway':
          if (gatewayCount === 0) {
            disabled = true;
            description = 'No gateways to remove';
          }
          break;
        case 'gateway-target':
          if (mcpToolCount === 0) {
            disabled = true;
            description = 'No gateway targets to remove';
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
        case 'all':
          // 'all' is always available
          break;
      }

      return { ...r, disabled, description };
    });
  }, [agentCount, gatewayCount, mcpToolCount, memoryCount, identityCount]);

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
