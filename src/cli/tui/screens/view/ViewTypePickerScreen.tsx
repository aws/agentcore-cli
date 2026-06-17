import { Screen, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import React, { useMemo } from 'react';

type ViewType = 'recommendation' | 'batch-evaluation' | 'ab-test';

interface ViewTypePickerScreenProps {
  onSelect: (type: ViewType) => void;
  onExit: () => void;
}

export function ViewTypePickerScreen({ onSelect, onExit }: ViewTypePickerScreenProps) {
  const items: SelectableItem[] = useMemo(
    () => [
      { id: 'recommendation', title: 'Recommendations', description: 'View recommendation job history and results' },
      {
        id: 'batch-evaluation',
        title: 'Batch Evaluations',
        description: 'View batch evaluation job history and results',
      },
      { id: 'ab-test', title: 'A/B Tests', description: 'View A/B test job history and results' },
    ],
    []
  );

  const nav = useListNavigation({
    items,
    onSelect: item => onSelect(item.id as ViewType),
    onExit,
    isActive: true,
  });

  return (
    <Screen title="View Jobs" onExit={onExit} helpText={HELP_TEXT.NAVIGATE_SELECT} exitEnabled={false}>
      <WizardSelect title="Choose a job type" items={items} selectedIndex={nav.selectedIndex} />
    </Screen>
  );
}
