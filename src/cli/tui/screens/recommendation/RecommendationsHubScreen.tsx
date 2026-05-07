import { Screen, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import React, { useMemo } from 'react';

export type RecommendationsHubView = 'run-recommendation' | 'recommendation-history';

interface RecommendationsHubScreenProps {
  onSelect: (view: RecommendationsHubView) => void;
  onExit: () => void;
}

export function RecommendationsHubScreen({ onSelect, onExit }: RecommendationsHubScreenProps) {
  const items: SelectableItem[] = useMemo(
    () => [
      {
        id: 'run-recommendation',
        title: 'Run Recommendation',
        description: 'Optimize system prompts and tool descriptions using agent traces',
      },
      {
        id: 'recommendation-history',
        title: 'Recommendation History',
        description: 'View past recommendation results (local)',
      },
    ],
    []
  );

  const nav = useListNavigation({
    items,
    onSelect: item => onSelect(item.id as RecommendationsHubView),
    onExit,
    isActive: true,
  });

  return (
    <Screen title="Recommendations [preview]" onExit={onExit} helpText={HELP_TEXT.NAVIGATE_SELECT} exitEnabled={false}>
      <WizardSelect title="Choose an option" items={items} selectedIndex={nav.selectedIndex} />
    </Screen>
  );
}
