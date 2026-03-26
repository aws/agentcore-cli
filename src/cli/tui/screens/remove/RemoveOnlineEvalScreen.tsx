import type { RemovableOnlineEvalConfig } from '../../../primitives/OnlineEvalConfigPrimitive';
import { SelectScreen } from '../../components';
import React from 'react';

interface RemoveOnlineEvalScreenProps {
  configs: RemovableOnlineEvalConfig[];
  onSelect: (configName: string) => void;
  onExit: () => void;
}

export function RemoveOnlineEvalScreen({ configs, onSelect, onExit }: RemoveOnlineEvalScreenProps) {
  const items = configs.map(config => ({
    id: config.name,
    title: config.name,
    description: 'Online Eval Config',
  }));

  return (
    <SelectScreen
      title="Select Online Eval Config to Remove"
      items={items}
      onSelect={item => onSelect(item.id)}
      onExit={onExit}
    />
  );
}
