import type { SelectableItem } from '../../components';
import { SelectScreen } from '../../components';
import { useMemo } from 'react';

const ATTACH_RESOURCES = [
  { id: 'agent', title: 'Agent', description: 'Invoke another agent as a tool' },
  { id: 'memory', title: 'Memory', description: 'Reference shared memory' },
  { id: 'identity', title: 'Identity', description: 'Reference shared credentials' },
  { id: 'mcp-runtime', title: 'MCP Runtime', description: 'Invoke MCP runtime tool' },
  { id: 'gateway', title: 'Gateway (coming soon)', description: 'Access MCP gateway', disabled: true },
] as const;

export type AttachResourceType = (typeof ATTACH_RESOURCES)[number]['id'];

interface AttachScreenProps {
  sourceAgent: string;
  onSelect: (resourceType: AttachResourceType) => void;
  onExit: () => void;
  /** Names of other agents in the project (for agent attachment) */
  otherAgents: string[];
  /** Names of owned memories that can be attached */
  availableMemories: string[];
  /** Names of owned identities that can be attached */
  availableIdentities: string[];
  /** Names of MCP runtime tools from mcp.json */
  availableMcpRuntimes: string[];
  /** Names of gateways from mcp.json */
  availableGateways: string[];
}

export function AttachScreen({
  sourceAgent,
  onSelect,
  onExit,
  otherAgents,
  availableMemories,
  availableIdentities,
  availableMcpRuntimes,
  // Gateway disabled - prefix with underscore until feature is re-enabled
  availableGateways: _availableGateways,
}: AttachScreenProps) {
  const items: SelectableItem[] = useMemo(() => {
    return ATTACH_RESOURCES.map(r => {
      let disabled = ('disabled' in r && r.disabled) || false;
      let description: string = r.description;

      switch (r.id) {
        case 'agent':
          if (otherAgents.length === 0) {
            disabled = true;
            description = 'No other agents available';
          }
          break;
        case 'memory':
          if (availableMemories.length === 0) {
            disabled = true;
            description = 'No memories available to attach';
          }
          break;
        case 'identity':
          if (availableIdentities.length === 0) {
            disabled = true;
            description = 'No identities available to attach';
          }
          break;
        case 'mcp-runtime':
          if (availableMcpRuntimes.length === 0) {
            disabled = true;
            description = 'No MCP runtimes defined in mcp.json';
          }
          break;
      }

      return { ...r, disabled, description };
    });
  }, [otherAgents, availableMemories, availableIdentities, availableMcpRuntimes]);

  const isDisabled = (item: SelectableItem) => item.disabled ?? false;

  return (
    <SelectScreen
      title={`Attach to ${sourceAgent}`}
      items={items}
      onSelect={item => onSelect(item.id as AttachResourceType)}
      onExit={onExit}
      isDisabled={isDisabled}
    />
  );
}
