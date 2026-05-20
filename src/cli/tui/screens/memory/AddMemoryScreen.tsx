import type { MemoryStrategyType } from '../../../../schema';
import { AgentNameSchema, StreamContentLevelSchema } from '../../../../schema';
import { ARN_VALIDATION_MESSAGE, isValidArn } from '../../../commands/shared/arn-utils';
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
import { CONTENT_LEVEL_OPTIONS, EVENT_EXPIRY_OPTIONS, MEMORY_STEP_LABELS, MEMORY_STRATEGY_OPTIONS } from './types';
import { useAddMemoryWizard } from './useAddMemoryWizard';
import React, { useMemo } from 'react';

interface AddMemoryScreenProps {
  onComplete: (config: AddMemoryConfig) => void;
  onExit: () => void;
  existingMemoryNames: string[];
}

const STREAMING_OPTIONS: SelectableItem[] = [
  { id: 'no', title: 'No', description: 'No streaming' },
  { id: 'yes', title: 'Yes', description: 'Stream memory record events to a delivery target (e.g. Kinesis)' },
];

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

  const contentLevelItems: SelectableItem[] = useMemo(
    () => CONTENT_LEVEL_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const isNameStep = wizard.step === 'name';
  const isExpiryStep = wizard.step === 'expiry';
  const isStrategiesStep = wizard.step === 'strategies';
  const isStreamingStep = wizard.step === 'streaming';
  const isStreamArnStep = wizard.step === 'streamArn';
  const isContentLevelStep = wizard.step === 'contentLevel';
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

  const streamingNav = useListNavigation({
    items: STREAMING_OPTIONS,
    onSelect: item => wizard.setStreamingEnabled(item.id === 'yes'),
    onExit: () => wizard.goBack(),
    isActive: isStreamingStep,
  });

  const contentLevelNav = useListNavigation({
    items: contentLevelItems,
    onSelect: item => wizard.setContentLevel(StreamContentLevelSchema.parse(item.id)),
    onExit: () => wizard.goBack(),
    isActive: isContentLevelStep,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const helpText = isStrategiesStep
    ? 'Space toggle · Enter confirm · Esc back'
    : isExpiryStep || isStreamingStep || isContentLevelStep
      ? HELP_TEXT.NAVIGATE_SELECT
      : isConfirmStep
        ? HELP_TEXT.CONFIRM_CANCEL
        : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={MEMORY_STEP_LABELS} />;

  const confirmFields = useMemo(
    () => [
      { label: 'Name', value: wizard.config.name },
      { label: 'Event Expiry', value: `${wizard.config.eventExpiryDuration} days` },
      { label: 'Strategies', value: wizard.config.strategies.map(s => s.type).join(', ') || 'None' },
      ...(wizard.config.streaming
        ? [
            { label: 'Stream ARN', value: wizard.config.streaming.dataStreamArn },
            { label: 'Content Level', value: wizard.config.streaming.contentLevel },
          ]
        : [{ label: 'Streaming', value: 'Disabled' }]),
    ],
    [wizard.config]
  );

  return (
    <Screen
      title="Add Memory"
      onExit={onExit}
      helpText={helpText}
      headerContent={headerContent}
      exitEnabled={isNameStep}
    >
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

        {isStreamingStep && (
          <WizardSelect
            title="Enable memory record streaming?"
            description="Stream memory record lifecycle events to a delivery target"
            items={STREAMING_OPTIONS}
            selectedIndex={streamingNav.selectedIndex}
          />
        )}

        {isStreamArnStep && (
          <TextInput
            key="streamArn"
            prompt="Delivery target ARN (e.g. Kinesis stream)"
            initialValue=""
            onSubmit={wizard.setStreamArn}
            onCancel={() => wizard.goBack()}
            customValidation={value => isValidArn(value) || ARN_VALIDATION_MESSAGE}
          />
        )}

        {isContentLevelStep && (
          <WizardSelect
            title="Stream content level"
            description="What data to include in stream events"
            items={contentLevelItems}
            selectedIndex={contentLevelNav.selectedIndex}
          />
        )}

        {isConfirmStep && <ConfirmReview fields={confirmFields} />}
      </Panel>
    </Screen>
  );
}
