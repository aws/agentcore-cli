import type { RemovableRuntimeEndpoint } from '../../../primitives/RuntimeEndpointPrimitive';
import { SelectScreen } from '../../components';
import React from 'react';

interface RemoveRuntimeEndpointScreenProps {
  /** List of runtime endpoints that can be removed */
  endpoints: RemovableRuntimeEndpoint[];
  /** Called when an endpoint is selected for removal */
  onSelect: (name: string) => void;
  /** Called when user cancels */
  onExit: () => void;
}

export function RemoveRuntimeEndpointScreen({ endpoints, onSelect, onExit }: RemoveRuntimeEndpointScreenProps) {
  const items = endpoints.map(ep => ({
    id: ep.name,
    title: ep.name,
    description: `${ep.runtimeName} v${ep.version}${ep.description ? ` — ${ep.description}` : ''}`,
  }));

  return (
    <SelectScreen
      title="Select Runtime Endpoint to Remove"
      items={items}
      onSelect={item => onSelect(item.id)}
      onExit={onExit}
    />
  );
}
