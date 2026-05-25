import { isPreviewEnabled } from '../../../feature-flags';
import type { SelectableItem } from '../../components';
import { SelectScreen } from '../../components';

export type AddResourceType =
  | 'harness'
  | 'agent'
  | 'memory'
  | 'credential'
  | 'evaluator'
  | 'online-eval'
  | 'gateway'
  | 'gateway-target'
  | 'runtime-endpoint'
  | 'policy'
  | 'config-bundle'
  | 'ab-test'
  | 'dataset';

const BASE_ADD_RESOURCES: { id: AddResourceType; title: string; description: string }[] = [
  { id: 'agent', title: 'Agent', description: 'Deploy an HTTP, MCP, A2A, or AG-UI agent' },
  { id: 'memory', title: 'Memory', description: 'Persistent context storage' },
  { id: 'credential', title: 'Credential', description: 'API key credential providers' },
  { id: 'evaluator', title: 'Evaluator', description: 'Custom LLM-as-a-Judge evaluator' },
  { id: 'online-eval', title: 'Online Eval Config', description: 'Continuous evaluation pipeline' },
  { id: 'gateway', title: 'Gateway', description: 'Route and manage gateway targets' },
  { id: 'gateway-target', title: 'Gateway Target', description: 'Extend agent capabilities' },
  { id: 'runtime-endpoint', title: 'Runtime Endpoint', description: 'Named endpoint for a runtime' },
  { id: 'policy', title: 'Policy', description: 'Cedar policies for gateway tools' },
  { id: 'dataset', title: 'Dataset', description: 'Evaluation dataset for testing agents' },
  { id: 'config-bundle', title: 'Configuration Bundle [preview]', description: 'Versioned component configurations' },
  { id: 'ab-test', title: 'AB Test [preview]', description: 'Compare agent configurations with traffic splitting' },
];

const ADD_RESOURCES: { id: AddResourceType; title: string; description: string }[] = [
  ...(isPreviewEnabled()
    ? [{ id: 'harness' as const, title: 'Harness', description: 'Managed config-based agent loop, no code required' }]
    : []),
  ...BASE_ADD_RESOURCES,
];

const ADD_RESOURCE_ITEMS: SelectableItem[] = ADD_RESOURCES.map(r => ({
  ...r,
  disabled: false,
  description: r.description,
}));

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
