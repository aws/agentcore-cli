import type { SelectableItem } from '../../components';
import { SelectScreen } from '../../components';

const ADD_RESOURCES = [
  { id: 'agent', title: 'Agent', description: 'Deploy an HTTP, MCP, or A2A agent' },
  { id: 'memory', title: 'Memory', description: 'Persistent context storage' },
  { id: 'identity', title: 'Identity', description: 'API key credential providers' },
  { id: 'gateway', title: 'Gateway', description: 'Route and manage gateway targets' },
  { id: 'gateway-target', title: 'Gateway Target', description: 'Extend agent capabilities' },
] as const;

const ADD_RESOURCE_ITEMS: SelectableItem[] = ADD_RESOURCES.map(r => ({
  ...r,
  disabled: Boolean('disabled' in r && r.disabled),
  description: r.description,
}));

export type AddResourceType = (typeof ADD_RESOURCES)[number]['id'];

interface AddScreenProps {
  onSelect: (resourceType: AddResourceType) => void;
  onExit: () => void;
}

export function AddScreen({ onSelect, onExit }: AddScreenProps) {
  const isDisabled = (item: SelectableItem) => item.disabled ?? false;

  return (
    <SelectScreen
      title="Add Resource"
      items={ADD_RESOURCE_ITEMS}
      onSelect={item => onSelect(item.id as AddResourceType)}
      onExit={onExit}
      isDisabled={isDisabled}
    />
  );
}
