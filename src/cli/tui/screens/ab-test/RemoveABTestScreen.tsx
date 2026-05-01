import type { RemovableResource } from '../../../primitives/types';
import type { SelectableItem } from '../../components';
import { SelectScreen } from '../../components';
import React, { useMemo } from 'react';

interface RemoveABTestScreenProps {
  abTests: RemovableResource[];
  onSelect: (testName: string) => void;
  onExit: () => void;
}

export function RemoveABTestScreen({ abTests, onSelect, onExit }: RemoveABTestScreenProps) {
  const items: SelectableItem[] = useMemo(
    () =>
      abTests.map(t => ({
        id: t.name,
        title: t.name,
        description: 'AB Test',
      })),
    [abTests]
  );

  return (
    <SelectScreen title="Select AB Test to Remove" items={items} onSelect={item => onSelect(item.id)} onExit={onExit} />
  );
}
