import type { RemovableDataset } from '../../../primitives/DatasetPrimitive';
import { SelectScreen } from '../../components';
import React from 'react';

interface RemoveDatasetScreenProps {
  datasets: RemovableDataset[];
  onSelect: (datasetName: string) => void;
  onExit: () => void;
}

export function RemoveDatasetScreen({ datasets, onSelect, onExit }: RemoveDatasetScreenProps) {
  const items = datasets.map(dataset => ({
    id: dataset.name,
    title: dataset.name,
    description: 'Dataset',
  }));

  return (
    <SelectScreen title="Select Dataset to Remove" items={items} onSelect={item => onSelect(item.id)} onExit={onExit} />
  );
}
