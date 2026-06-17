import { Screen, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import React, { useMemo } from 'react';

interface RunScreenProps {
  onRunEval: () => void;
  onRunBatchEval: () => void;
  onRunInsights: () => void;
  onRunRecommendation: () => void;
  onRunIngest: () => void;
  onRunABTest: () => void;
  onExit: () => void;
}

export function RunScreen({
  onRunEval,
  onRunBatchEval,
  onRunInsights,
  onRunRecommendation,
  onRunIngest,
  onRunABTest,
  onExit,
}: RunScreenProps) {
  const items: SelectableItem[] = useMemo(
    () => [
      {
        id: 'run-eval',
        title: 'On-demand Evaluation',
        description: 'Evaluate agent traces with selected evaluators. CLI also supports --agent-arn.',
      },
      {
        id: 'run-batch-eval',
        title: 'Batch Evaluation',
        description: 'Run a batch evaluation against agent sessions via CloudWatch.',
      },
      {
        id: 'run-insights',
        title: 'Insights [preview]',
        description: 'Run failure analysis across agent sessions to detect patterns and root causes.',
      },
      {
        id: 'run-recommendation',
        title: 'Recommendation',
        description: 'Optimize system prompts or tool descriptions using agent traces.',
      },
      {
        id: 'run-ingest',
        title: 'Ingest knowledge base',
        description: 'Start an ingestion job for a deployed knowledge base.',
      },
      {
        id: 'run-ab-test',
        title: 'A/B Test',
        description: 'Compare two config-bundle or gateway-target variants live through a gateway.',
      },
    ],
    []
  );

  const nav = useListNavigation({
    items,
    onSelect: item => {
      if (item.id === 'run-eval') onRunEval();
      else if (item.id === 'run-batch-eval') onRunBatchEval();
      else if (item.id === 'run-insights') onRunInsights();
      else if (item.id === 'run-recommendation') onRunRecommendation();
      else if (item.id === 'run-ingest') onRunIngest();
      else if (item.id === 'run-ab-test') onRunABTest();
    },
    onExit,
    isActive: true,
  });

  return (
    <Screen title="Run" onExit={onExit} helpText={HELP_TEXT.NAVIGATE_SELECT} exitEnabled={false}>
      <WizardSelect title="Choose an operation" items={items} selectedIndex={nav.selectedIndex} />
    </Screen>
  );
}
