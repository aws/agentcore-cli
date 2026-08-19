import type { RemovableResource } from '../../../primitives/types';
import { SelectScreen } from '../../components';
import React from 'react';

interface RemoveCapacityProviderScreenProps {
  capacityProviders: RemovableResource[];
  onSelect: (capacityProviderName: string) => void;
  onExit: () => void;
}

export function RemoveCapacityProviderScreen({
  capacityProviders,
  onSelect,
  onExit,
}: RemoveCapacityProviderScreenProps) {
  const items = capacityProviders.map(cp => ({
    id: cp.name,
    title: cp.name,
    description: 'Capacity Provider',
  }));

  return (
    <SelectScreen
      title="Select Capacity Provider to Remove"
      items={items}
      onSelect={item => onSelect(item.id)}
      onExit={onExit}
    />
  );
}
