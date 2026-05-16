import type { IndexedKeyType, MemoryStrategyType } from '../../../../schema';
import { AgentNameSchema, StreamContentLevelSchema } from '../../../../schema';
import { ARN_VALIDATION_MESSAGE, isValidArn } from '../../../commands/shared/arn-utils';
import { validateIndexedKeyName } from '../../../commands/shared/indexed-key-parser';
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
import type { AddMemoryConfig, AddMemoryIndexedKeyConfig } from './types';
import {
  CONTENT_LEVEL_OPTIONS,
  EVENT_EXPIRY_OPTIONS,
  INDEXED_KEY_TYPE_OPTIONS,
  MEMORY_STEP_LABELS,
  MEMORY_STRATEGY_OPTIONS,
} from './types';
import { useAddMemoryWizard } from './useAddMemoryWizard';
import { Box, Text } from 'ink';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

interface AddMemoryScreenProps {
  onComplete: (config: AddMemoryConfig) => void;
  onExit: () => void;
  existingMemoryNames: string[];
}

const STREAMING_OPTIONS: SelectableItem[] = [
  { id: 'no', title: 'No', description: 'No streaming' },
  { id: 'yes', title: 'Yes', description: 'Stream memory record events to a delivery target (e.g. Kinesis)' },
];

type IndexedKeysSubStep = 'prompt' | 'keyName' | 'keyType' | 'addAnother';

export function AddMemoryScreen({ onComplete, onExit, existingMemoryNames }: AddMemoryScreenProps) {
  const wizard = useAddMemoryWizard();

  // Indexed keys sub-flow state
  const [indexedKeysSubStep, setIndexedKeysSubStep] = useState<IndexedKeysSubStep>('prompt');
  const [pendingKeyName, setPendingKeyName] = useState('');
  const [collectedKeys, setCollectedKeys] = useState<AddMemoryIndexedKeyConfig[]>([]);

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

  const indexedKeyTypeItems: SelectableItem[] = useMemo(
    () => INDEXED_KEY_TYPE_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const isNameStep = wizard.step === 'name';
  const isExpiryStep = wizard.step === 'expiry';
  const isStrategiesStep = wizard.step === 'strategies';
  const isIndexedKeysStep = wizard.step === 'indexedKeys';

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (
      isIndexedKeysStep &&
      indexedKeysSubStep === 'prompt' &&
      collectedKeys.length === 0 &&
      wizard.config.indexedKeys &&
      wizard.config.indexedKeys.length > 0
    ) {
      setCollectedKeys(wizard.config.indexedKeys);
      setIndexedKeysSubStep('addAnother');
    }
  }, [isIndexedKeysStep, indexedKeysSubStep, collectedKeys.length, wizard.config.indexedKeys]);
  /* eslint-enable react-hooks/set-state-in-effect */

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

  // Indexed keys sub-flow: initial prompt (yes/no)
  const INDEXED_KEYS_PROMPT_OPTIONS: SelectableItem[] = useMemo(
    () => [
      { id: 'no', title: 'No', description: 'Skip indexed keys' },
      { id: 'yes', title: 'Yes', description: 'Define keys for metadata filtering on retrieval' },
    ],
    []
  );

  const ADD_ANOTHER_OPTIONS: SelectableItem[] = useMemo(
    () => [
      { id: 'no', title: 'No', description: 'Done adding keys' },
      { id: 'yes', title: 'Yes', description: `Add another key (${collectedKeys.length}/10 defined)` },
      { id: 'clear', title: 'Clear keys', description: 'Discard all keys and start over' },
    ],
    [collectedKeys.length]
  );

  const indexedKeysPromptNav = useListNavigation({
    items: INDEXED_KEYS_PROMPT_OPTIONS,
    onSelect: item => {
      if (item.id === 'yes') {
        setIndexedKeysSubStep('keyName');
      } else {
        wizard.setIndexedKeys([]);
      }
    },
    onExit: () => wizard.goBack(),
    isActive: isIndexedKeysStep && indexedKeysSubStep === 'prompt',
  });

  const handleKeyNameSubmit = useCallback((name: string) => {
    setPendingKeyName(name);
    setIndexedKeysSubStep('keyType');
  }, []);

  const indexedKeyTypeNav = useListNavigation({
    items: indexedKeyTypeItems,
    onSelect: item => {
      const newKey: AddMemoryIndexedKeyConfig = { key: pendingKeyName, type: item.id as IndexedKeyType };
      const updated = [...collectedKeys, newKey];
      setCollectedKeys(updated);
      setPendingKeyName('');
      if (updated.length >= 10) {
        wizard.setIndexedKeys(updated);
        setCollectedKeys([]);
        setIndexedKeysSubStep('prompt');
      } else {
        setIndexedKeysSubStep('addAnother');
      }
    },
    onExit: () => setIndexedKeysSubStep('keyName'),
    isActive: isIndexedKeysStep && indexedKeysSubStep === 'keyType',
  });

  const addAnotherNav = useListNavigation({
    items: ADD_ANOTHER_OPTIONS,
    onSelect: item => {
      if (item.id === 'yes') {
        setIndexedKeysSubStep('keyName');
      } else if (item.id === 'clear') {
        // Discard everything and return to the initial Yes/No prompt as if
        // entering the step for the first time.
        setCollectedKeys([]);
        wizard.clearIndexedKeys();
        setIndexedKeysSubStep('prompt');
      } else {
        wizard.setIndexedKeys(collectedKeys);
        setCollectedKeys([]);
        setIndexedKeysSubStep('prompt');
      }
    },
    onExit: () => {
      const lastKey = collectedKeys[collectedKeys.length - 1];
      if (lastKey) {
        setPendingKeyName(lastKey.key);
        setCollectedKeys(collectedKeys.slice(0, -1));
        setIndexedKeysSubStep('keyType');
      }
    },
    isActive: isIndexedKeysStep && indexedKeysSubStep === 'addAnother',
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
      : isIndexedKeysStep && (indexedKeysSubStep === 'prompt' || indexedKeysSubStep === 'addAnother')
        ? HELP_TEXT.NAVIGATE_SELECT
        : isIndexedKeysStep && indexedKeysSubStep === 'keyType'
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
      ...(wizard.config.indexedKeys && wizard.config.indexedKeys.length > 0
        ? [{ label: 'Indexed Keys', value: wizard.config.indexedKeys.map(k => `${k.key} (${k.type})`).join(', ') }]
        : []),
      ...(wizard.config.streaming
        ? [
            { label: 'Stream ARN', value: wizard.config.streaming.dataStreamArn },
            { label: 'Content Level', value: wizard.config.streaming.contentLevel },
          ]
        : [{ label: 'Streaming', value: 'Disabled' }]),
    ],
    [wizard.config]
  );

  const existingKeyNames = useMemo(() => collectedKeys.map(k => k.key), [collectedKeys]);

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

        {isIndexedKeysStep && indexedKeysSubStep === 'prompt' && (
          <WizardSelect
            title="Define indexed metadata keys?"
            description="Indexed keys enable filtering on memory records during retrieval"
            items={INDEXED_KEYS_PROMPT_OPTIONS}
            selectedIndex={indexedKeysPromptNav.selectedIndex}
          />
        )}

        {isIndexedKeysStep && indexedKeysSubStep === 'keyName' && (
          <Box flexDirection="column">
            {collectedKeys.length > 0 && (
              <Box flexDirection="column" marginBottom={1}>
                {collectedKeys.map(k => (
                  <Text key={k.key} color="green">
                    {`  ✓ ${k.key} (${k.type})`}
                  </Text>
                ))}
              </Box>
            )}
            <TextInput
              key={`keyName-${collectedKeys.length}`}
              prompt="Metadata key name"
              initialValue={pendingKeyName}
              onSubmit={handleKeyNameSubmit}
              onCancel={() => {
                setPendingKeyName('');
                if (collectedKeys.length > 0) {
                  setIndexedKeysSubStep('addAnother');
                } else {
                  wizard.clearIndexedKeys();
                  setIndexedKeysSubStep('prompt');
                }
              }}
              customValidation={value => validateIndexedKeyName(value, existingKeyNames)}
            />
          </Box>
        )}

        {isIndexedKeysStep && indexedKeysSubStep === 'keyType' && (
          <Box flexDirection="column">
            {collectedKeys.length > 0 && (
              <Box flexDirection="column" marginBottom={1}>
                {collectedKeys.map(k => (
                  <Text key={k.key} color="green">
                    {`  ✓ ${k.key} (${k.type})`}
                  </Text>
                ))}
              </Box>
            )}
            <WizardSelect
              title={`Select type for "${pendingKeyName}"`}
              description="Data type for this metadata key"
              items={indexedKeyTypeItems}
              selectedIndex={indexedKeyTypeNav.selectedIndex}
            />
          </Box>
        )}

        {isIndexedKeysStep && indexedKeysSubStep === 'addAnother' && (
          <Box flexDirection="column">
            <Box flexDirection="column" marginBottom={1}>
              {collectedKeys.map(k => (
                <Text key={k.key} color="green">
                  {`  ✓ ${k.key} (${k.type})`}
                </Text>
              ))}
            </Box>
            <WizardSelect
              title="Add another indexed key?"
              description={`${collectedKeys.length} of 10 maximum keys defined`}
              items={ADD_ANOTHER_OPTIONS}
              selectedIndex={addAnotherNav.selectedIndex}
            />
          </Box>
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
