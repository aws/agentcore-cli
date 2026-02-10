import type { MemoryStrategyType } from '../../../../schema';
import { AgentNameSchema } from '../../../../schema';
import {
  ConfirmReview,
  Panel,
  Screen,
  StepIndicator,
  TextInput,
  WizardMultiSelect,
  WizardSelect,
} from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddMemoryConfig } from './types';
import { EVENT_EXPIRY_OPTIONS, MEMORY_STEP_LABELS, MEMORY_STRATEGY_OPTIONS } from './types';
import { useAddMemoryWizard } from './useAddMemoryWizard';
import React, { useMemo } from 'react';

interface AddMemoryScreenProps {
  onComplete: (config: AddMemoryConfig) => void;
  onExit: () => void;
  existingMemoryNames: string[];
}

export function AddMemoryScreen({ onComplete, onExit, existingMemoryNames }: AddMemoryScreenProps) {
  const wizard = useAddMemoryWizard();

  const strategyItems: SelectableItem[] = useMemo(
    () => MEMORY_STRATEGY_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const expiryItems: SelectableItem[] = useMemo(
    () => EVENT_EXPIRY_OPTIONS.map(opt => ({ id: String(opt.id), title: opt.title, description: opt.description })),
    []
  );

  const isNameStep = wizard.step === 'name';
  const isExpiryStep = wizard.step === 'expiry';
  const isStrategiesStep = wizard.step === 'strategies';
  const isConfirmStep = wizard.step === 'confirm';

  const expiryNav = useListNavigation({
    items: expiryItems,
    onSelect: item => wizard.setExpiry(Number(item.id)),
    onExit: () => wizard.goBack(),
    isActive: isExpiryStep,
  });

  const strategiesNav = useMultiSelectNavigation({
    items: strategyItems,
    getId: item => item.id,
    onConfirm: ids => wizard.setStrategyTypes(ids as MemoryStrategyType[]),
    onExit: () => wizard.goBack(),
    isActive: isStrategiesStep,
    requireSelection: false,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const helpText = isStrategiesStep
    ? 'Space toggle · Enter confirm · Esc back'
    : isExpiryStep
      ? HELP_TEXT.NAVIGATE_SELECT
      : isConfirmStep
        ? HELP_TEXT.CONFIRM_CANCEL
        : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={MEMORY_STEP_LABELS} />;

  return (
    <Screen title="Add Memory" onExit={onExit} helpText={helpText} headerContent={headerContent}>
      <Panel>
        {isNameStep && (
          <TextInput
            key="name"
            prompt="Memory name"
            initialValue={generateUniqueName('MyMemory', existingMemoryNames)}
            onSubmit={wizard.setName}
            onCancel={onExit}
            schema={AgentNameSchema}
            customValidation={value => !existingMemoryNames.includes(value) || 'Memory name already exists'}
          />
        )}

        {isExpiryStep && (
          <WizardSelect
            title="Event expiry duration"
            description="How long to retain memory events"
            items={expiryItems}
            selectedIndex={expiryNav.selectedIndex}
          />
        )}

        {isStrategiesStep && (
          <WizardMultiSelect
            title="Select memory strategies"
            description="Choose strategies for this memory (optional)"
            items={strategyItems}
            cursorIndex={strategiesNav.cursorIndex}
            selectedIds={strategiesNav.selectedIds}
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Name', value: wizard.config.name },
              { label: 'Event Expiry', value: `${wizard.config.eventExpiryDuration} days` },
              { label: 'Strategies', value: wizard.config.strategies.map(s => s.type).join(', ') || 'None' },
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}
