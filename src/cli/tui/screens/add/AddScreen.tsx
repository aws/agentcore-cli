import type { SelectableItem } from '../../components';
import { SelectScreen } from '../../components';
import { useMemo } from 'react';

const ADD_RESOURCES = [
  { id: 'agent', title: 'Agent', description: 'New or existing agent code' },
  { id: 'memory', title: 'Memory', description: 'Persistent context storage' },
  { id: 'identity', title: 'Identity', description: 'API key credential providers' },
  { id: 'gateway', title: 'Gateway', description: 'Route and manage gateway targets' },
  { id: 'gateway-target', title: 'Gateway Target', description: 'Extend agent capabilities' },
] as const;

export type AddResourceType = (typeof ADD_RESOURCES)[number]['id'];

interface AddScreenProps {
  onSelect: (resourceType: AddResourceType) => void;
  onExit: () => void;
  /** Whether at least one agent exists in the project */
  hasAgents: boolean;
}

export function AddScreen({ onSelect, onExit, hasAgents }: AddScreenProps) {
  const items: SelectableItem[] = useMemo(
    () =>
      ADD_RESOURCES.map(r => ({
        ...r,
        disabled: Boolean('disabled' in r && r.disabled) || (r.id === 'memory' && !hasAgents),
        description: r.id === 'memory' && !hasAgents ? 'Add an agent first' : r.description,
      })),
    [hasAgents]
  );

  const isDisabled = (item: SelectableItem) => item.disabled ?? false;

  return (
    <SelectScreen
      title="Add Resource"
      items={items}
      onSelect={item => onSelect(item.id as AddResourceType)}
      onExit={onExit}
      isDisabled={isDisabled}
    />
  );
}
