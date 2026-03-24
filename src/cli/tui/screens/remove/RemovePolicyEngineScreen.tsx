import type { RemovableResource } from '../../../primitives/types';
import { SelectScreen } from '../../components';
import React from 'react';

interface RemovePolicyEngineScreenProps {
  /** List of policy engines that can be removed */
  policyEngines: RemovableResource[];
  /** Called when a policy engine is selected for removal */
  onSelect: (engineName: string) => void;
  /** Called when user cancels */
  onExit: () => void;
}

export function RemovePolicyEngineScreen({ policyEngines, onSelect, onExit }: RemovePolicyEngineScreenProps) {
  const items = policyEngines.map(engine => ({
    id: engine.name,
    title: engine.name,
  }));

  return (
    <SelectScreen
      title="Select Policy Engine to Remove"
      items={items}
      onSelect={item => onSelect(item.id)}
      onExit={onExit}
    />
  );
}
