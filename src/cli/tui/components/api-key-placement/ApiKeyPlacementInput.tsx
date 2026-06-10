import type { ApiKeyOutboundConfig } from '../../../../schema';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { TextInput, WizardMultiSelect, WizardSelect } from '../index';
import type { SelectableItem } from '../index';
import type { ApiKeyPlacementSubStep } from './types';
import { PLACEMENT_OPTIONS } from './types';
import { Box } from 'ink';
import React, { useRef, useState } from 'react';

export interface ApiKeyPlacementInputProps {
  /** Called with the resolved placement (undefined = all defaults / skipped). */
  onComplete: (placement: ApiKeyOutboundConfig | undefined) => void;
  onBack: () => void;
}

const LOCATION_ITEMS: SelectableItem[] = [
  { id: 'HEADER', title: 'HEADER', description: 'Send the key in an HTTP header' },
  { id: 'QUERY_PARAMETER', title: 'QUERY_PARAMETER', description: 'Send the key as a query parameter' },
];

const CHECKLIST_ITEMS: SelectableItem[] = PLACEMENT_OPTIONS.map(o => ({ id: o.id, title: o.title }));

export function ApiKeyPlacementInput({ onComplete, onBack }: ApiKeyPlacementInputProps) {
  const [subStep, setSubStep] = useState<ApiKeyPlacementSubStep>('checklist');
  const [pending, setPending] = useState<ApiKeyPlacementSubStep[]>([]);
  const resolved = useRef<ApiKeyOutboundConfig>({});

  const finish = () => {
    const result = Object.keys(resolved.current).length > 0 ? { ...resolved.current } : undefined;
    onComplete(result);
  };

  const advance = (queue: ApiKeyPlacementSubStep[]) => {
    if (queue.length > 0) {
      const [next, ...rest] = queue;
      setPending(rest);
      setSubStep(next!);
    } else {
      finish();
    }
  };

  const checklistNav = useMultiSelectNavigation({
    items: CHECKLIST_ITEMS,
    getId: (item: SelectableItem) => item.id,
    onConfirm: (selectedIds: string[]) => {
      const queue: ApiKeyPlacementSubStep[] = [];
      if (selectedIds.includes('location')) queue.push('location');
      if (selectedIds.includes('parameterName')) queue.push('parameterName');
      if (selectedIds.includes('prefix')) queue.push('prefix');
      advance(queue);
    },
    onExit: onBack,
    isActive: subStep === 'checklist',
    requireSelection: false,
  });

  const locationNav = useListNavigation({
    items: LOCATION_ITEMS,
    onSelect: (item: SelectableItem) => {
      if (item.id !== 'HEADER') {
        resolved.current.location = item.id as ApiKeyOutboundConfig['location'];
      }
      advance(pending);
    },
    onExit: () => setSubStep('checklist'),
    isActive: subStep === 'location',
  });

  if (subStep === 'checklist') {
    return (
      <Box flexDirection="column">
        <WizardMultiSelect
          title="API key placement (optional)"
          description="Space to toggle · Enter to continue (skip = keep defaults HEADER / x-api-key) · Esc back"
          items={CHECKLIST_ITEMS}
          cursorIndex={checklistNav.cursorIndex}
          selectedIds={checklistNav.selectedIds}
        />
      </Box>
    );
  }

  if (subStep === 'location') {
    return (
      <WizardSelect
        title="API key location"
        description="Where to place the key on the outbound request"
        items={LOCATION_ITEMS}
        selectedIndex={locationNav.selectedIndex}
      />
    );
  }

  if (subStep === 'parameterName') {
    return (
      <TextInput
        key="apiKeyParameterName"
        prompt="Parameter name (e.g. Authorization)"
        initialValue="x-api-key"
        onSubmit={(value: string) => {
          const v = value.trim();
          if (v && v !== 'x-api-key') resolved.current.parameterName = v;
          advance(pending);
        }}
        onCancel={() => setSubStep('checklist')}
      />
    );
  }

  return (
    <TextInput
      key="apiKeyPrefix"
      prompt="Prefix (e.g. Bearer; press Enter to skip)"
      onSubmit={(value: string) => {
        const v = value.trim();
        if (v) resolved.current.prefix = v;
        advance(pending);
      }}
      onCancel={() => setSubStep('checklist')}
      allowEmpty
    />
  );
}
