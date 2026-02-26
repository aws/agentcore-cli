import type { RemovableGatewayTarget } from '../../../operations/remove';
import { SelectScreen } from '../../components';
import React from 'react';

interface RemoveGatewayTargetScreenProps {
  /** List of gateway targets that can be removed */
  tools: RemovableGatewayTarget[];
  /** Called when a tool is selected for removal */
  onSelect: (tool: RemovableGatewayTarget) => void;
  /** Called when user cancels */
  onExit: () => void;
}

export function RemoveGatewayTargetScreen({ tools, onSelect, onExit }: RemoveGatewayTargetScreenProps) {
  const items = tools.map(tool => ({
    id: tool.name,
    title: tool.name,
    description: `Gateway target (${tool.gatewayName})`,
  }));

  // Create a map for quick lookup
  const toolMap = new Map(tools.map(t => [t.name, t]));

  return (
    <SelectScreen
      title="Select Gateway Target to Remove"
      items={items}
      onSelect={item => {
        const tool = toolMap.get(item.id);
        if (tool) {
          onSelect(tool);
        }
      }}
      onExit={onExit}
    />
  );
}
