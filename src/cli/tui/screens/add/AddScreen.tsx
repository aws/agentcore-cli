import type { SelectableItem } from '../../components';
import { SelectScreen } from '../../components';

export type AddResourceType =
  | 'harness'
  | 'agent'
  | 'memory'
  | 'knowledge-base'
  | 'credential'
  | 'evaluator'
  | 'online-eval'
  | 'online-insights'
  | 'gateway'
  | 'gateway-target'
  | 'runtime-endpoint'
  | 'policy'
  | 'config-bundle'
  | 'dataset'
  | 'payment-manager'
  | 'payment-connector'
  | 'capacity-provider';

const BASE_ADD_RESOURCES: { id: AddResourceType; title: string; description: string }[] = [
  { id: 'agent', title: 'Agent', description: 'Deploy an HTTP, MCP, A2A, or AG-UI agent' },
  { id: 'memory', title: 'Memory', description: 'Persistent context storage' },
  { id: 'knowledge-base', title: 'Knowledge Base', description: 'Create a managed knowledge base for retrieval' },
  { id: 'credential', title: 'Credential', description: 'API key credential providers' },
  { id: 'evaluator', title: 'Evaluator', description: 'Custom LLM-as-a-Judge evaluator' },
  { id: 'online-eval', title: 'Online Eval Config', description: 'Continuous evaluation pipeline' },
  { id: 'online-insights', title: 'Online Insights [preview]', description: 'Continuous failure analysis pipeline' },
  { id: 'gateway', title: 'Gateway', description: 'Route and manage gateway targets' },
  { id: 'gateway-target', title: 'Gateway Target', description: 'Extend agent capabilities' },
  { id: 'runtime-endpoint', title: 'Runtime Endpoint', description: 'Named endpoint for a runtime' },
  { id: 'policy', title: 'Policy', description: 'Cedar policies for gateway tools' },
  { id: 'dataset', title: 'Dataset', description: 'Evaluation dataset for testing agents' },
  { id: 'config-bundle', title: 'Configuration Bundle', description: 'Versioned component configurations' },
  { id: 'payment-manager', title: 'Payment Manager', description: 'x402 crypto microtransactions config' },
  {
    id: 'payment-connector',
    title: 'Payment Connector',
    description: 'Link payment provider credentials to a manager',
  },
  {
    id: 'capacity-provider',
    title: 'Capacity Provider',
    description: 'Customer-managed EC2 compute pool for runtimes',
  },
];

const ADD_RESOURCES: { id: AddResourceType; title: string; description: string }[] = [
  { id: 'harness', title: 'Harness', description: 'Managed config-based agent loop, no code required' },
  ...BASE_ADD_RESOURCES,
];

const ADD_RESOURCE_ITEMS: SelectableItem[] = ADD_RESOURCES.map(r => {
  const gated = false;
  return {
    ...r,
    disabled: gated,
    description: gated ? 'Coming soon' : r.description,
  };
});

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
      onSelect={item => {
        // Safe: ADD_RESOURCE_ITEMS is built from ADD_RESOURCES whose ids are
        // typed as AddResourceType.
        const resource = ADD_RESOURCES.find(r => r.id === item.id);
        if (resource) onSelect(resource.id);
      }}
      onExit={onExit}
      isDisabled={isDisabled}
    />
  );
}
