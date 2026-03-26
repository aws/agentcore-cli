import { Screen, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import React, { useMemo } from 'react';

interface RunScreenProps {
  onRunEval: () => void;
  onExit: () => void;
}

export function RunScreen({ onRunEval, onExit }: RunScreenProps) {
  const items: SelectableItem[] = useMemo(
    () => [
      {
        id: 'run-eval',
        title: 'On-demand Evaluation',
        description: 'Evaluate agent traces with selected evaluators. CLI also supports --agent-arn.',
      },
    ],
    []
  );

  const nav = useListNavigation({
    items,
    onSelect: () => onRunEval(),
    onExit,
    isActive: true,
  });

  return (
    <Screen title="Run" onExit={onExit} helpText={HELP_TEXT.NAVIGATE_SELECT} exitEnabled={false}>
      <WizardSelect title="Choose an operation" items={items} selectedIndex={nav.selectedIndex} />
    </Screen>
  );
}
