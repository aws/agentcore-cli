import { Screen, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import React, { useMemo } from 'react';

type EvalHubView =
  | 'run-eval'
  | 'runs'
  | 'run-batch-eval'
  | 'batch-eval-history'
  | 'run-insights'
  | 'insights-jobs'
  | 'online-dashboard';

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
      { id: 'runs', title: 'Eval Runs', description: 'View past on-demand eval results and scores' },
      {
        id: 'run-batch-eval',
        title: 'Run Batch Evaluation',
        description: 'Run a batch evaluation against agent sessions via CloudWatch',
      },
      {
        id: 'batch-eval-history',
        title: 'Batch Eval Jobs',
        description: 'View batch evaluation jobs and their results',
      },
      {
        id: 'run-insights',
        title: 'Run Insights [preview]',
        description: 'Run failure analysis on agent sessions',
      },
      {
        id: 'insights-jobs',
        title: 'Insights Jobs [preview]',
        description: 'View past insights analysis jobs',
      },
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
