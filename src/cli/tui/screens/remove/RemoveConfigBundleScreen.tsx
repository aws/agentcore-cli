import type { RemovableConfigBundle } from '../../../primitives/ConfigBundlePrimitive';
import { SelectScreen } from '../../components';
import React from 'react';

interface RemoveConfigBundleScreenProps {
  configBundles: RemovableConfigBundle[];
  onSelect: (bundleName: string) => void;
  onExit: () => void;
}

export function RemoveConfigBundleScreen({ configBundles, onSelect, onExit }: RemoveConfigBundleScreenProps) {
  const items = configBundles.map(bundle => ({
    id: bundle.name,
    title: bundle.name,
    description: 'Configuration Bundle',
  }));

  return (
    <SelectScreen
      title="Select Configuration Bundle to Remove"
      items={items}
      onSelect={item => onSelect(item.id)}
      onExit={onExit}
    />
  );
}
