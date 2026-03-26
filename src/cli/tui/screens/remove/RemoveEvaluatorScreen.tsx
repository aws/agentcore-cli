import type { RemovableEvaluator } from '../../../primitives/EvaluatorPrimitive';
import { SelectScreen } from '../../components';
import React from 'react';

interface RemoveEvaluatorScreenProps {
  evaluators: RemovableEvaluator[];
  onSelect: (evaluatorName: string) => void;
  onExit: () => void;
}

export function RemoveEvaluatorScreen({ evaluators, onSelect, onExit }: RemoveEvaluatorScreenProps) {
  const items = evaluators.map(evaluator => ({
    id: evaluator.name,
    title: evaluator.name,
    description: 'Custom Evaluator',
  }));

  return (
    <SelectScreen
      title="Select Evaluator to Remove"
      items={items}
      onSelect={item => onSelect(item.id)}
      onExit={onExit}
    />
  );
}
