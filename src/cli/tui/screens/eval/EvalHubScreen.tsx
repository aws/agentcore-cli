import { Screen, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import React, { useMemo } from 'react';

type EvalHubView = 'run-eval' | 'runs' | 'online-dashboard';

interface EvalHubScreenProps {
  onSelect: (view: EvalHubView) => void;
  onExit: () => void;
}

export function EvalHubScreen({ onSelect, onExit }: EvalHubScreenProps) {
  const items: SelectableItem[] = useMemo(
    () => [
      {
        id: 'run-eval',
        title: 'Run On-demand Evaluation',
        description: 'Evaluate agent traces with selected evaluators',
      },
      { id: 'runs', title: 'Eval Runs', description: 'View past eval run results and scores' },
      {
        id: 'online-dashboard',
        title: 'Online Eval Dashboard',
        description: 'View and manage deployed online eval configs',
      },
    ],
    []
  );

  const nav = useListNavigation({
    items,
    onSelect: item => onSelect(item.id as EvalHubView),
    onExit,
    isActive: true,
  });

  return (
    <Screen title="Evaluations" onExit={onExit} helpText={HELP_TEXT.NAVIGATE_SELECT} exitEnabled={false}>
      <WizardSelect title="Choose a view" items={items} selectedIndex={nav.selectedIndex} />
    </Screen>
  );
}
