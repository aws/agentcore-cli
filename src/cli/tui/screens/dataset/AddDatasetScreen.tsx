import type { DatasetSchemaType } from '../../../../schema';
import { DatasetNameSchema } from '../../../../schema';
import { ConfirmReview, Panel, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import React, { useMemo, useState } from 'react';

const SCHEMA_TYPE_OPTIONS: SelectableItem[] = [
  {
    id: 'AGENTCORE_EVALUATION_PREDEFINED_V1',
    title: 'Predefined Turns',
    description: 'Explicit inputs with expected responses',
  },
  {
    id: 'AGENTCORE_EVALUATION_SIMULATED_V1',
    title: 'Actor Simulator',
    description: 'Actor profiles for synthetic conversations',
  },
];

export interface AddDatasetConfig {
  name: string;
  schemaType: DatasetSchemaType;
  description?: string;
}

type Step = 'name' | 'schema-type' | 'description' | 'confirm';

const STEP_LABELS: Record<Step, string> = {
  name: 'Name',
  'schema-type': 'Schema Type',
  description: 'Description',
  confirm: 'Confirm',
};

const STEPS: Step[] = ['name', 'schema-type', 'description', 'confirm'];

interface AddDatasetScreenProps {
  onComplete: (config: AddDatasetConfig) => void;
  onExit: () => void;
  existingDatasetNames: string[];
}

export function AddDatasetScreen({ onComplete, onExit, existingDatasetNames }: AddDatasetScreenProps) {
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [schemaType, setSchemaType] = useState<DatasetSchemaType>('AGENTCORE_EVALUATION_PREDEFINED_V1');
  const [description, setDescription] = useState('');

  const isNameStep = step === 'name';
  const isSchemaTypeStep = step === 'schema-type';
  const isDescriptionStep = step === 'description';
  const isConfirmStep = step === 'confirm';

  const schemaTypeNav = useListNavigation({
    items: SCHEMA_TYPE_OPTIONS,
    isActive: isSchemaTypeStep,
    onSelect: (item: SelectableItem) => {
      setSchemaType(item.id as DatasetSchemaType);
      setStep('description');
    },
    onExit: () => setStep('name'),
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete({ name, schemaType, description: description || undefined }),
    onExit: () => setStep('description'),
    isActive: isConfirmStep,
  });

  const helpText = isSchemaTypeStep
    ? HELP_TEXT.NAVIGATE_SELECT
    : isConfirmStep
      ? HELP_TEXT.CONFIRM_CANCEL
      : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={STEPS} currentStep={step} labels={STEP_LABELS} />;

  const confirmFields = useMemo(
    () => [
      { label: 'Name', value: name },
      { label: 'Schema Type', value: schemaType },
      ...(description ? [{ label: 'Description', value: description }] : []),
    ],
    [name, schemaType, description]
  );

  return (
    <Screen
      title="Add Dataset"
      onExit={onExit}
      helpText={helpText}
      headerContent={headerContent}
      exitEnabled={isNameStep}
    >
      <Panel>
        {isNameStep && (
          <TextInput
            key="name"
            prompt="Dataset name"
            initialValue={generateUniqueName('MyDataset', existingDatasetNames)}
            onSubmit={(value: string) => {
              setName(value);
              setStep('schema-type');
            }}
            onCancel={onExit}
            schema={DatasetNameSchema}
            customValidation={value => !existingDatasetNames.includes(value) || 'Dataset name already exists'}
          />
        )}

        {isSchemaTypeStep && (
          <WizardSelect
            title="Schema type"
            description="Choose the structure for your dataset examples"
            items={SCHEMA_TYPE_OPTIONS}
            selectedIndex={schemaTypeNav.selectedIndex}
          />
        )}

        {isDescriptionStep && (
          <TextInput
            key="description"
            prompt="Description (optional, press Enter to skip)"
            onSubmit={(value: string) => {
              setDescription(value);
              setStep('confirm');
            }}
            onCancel={() => setStep('schema-type')}
            allowEmpty
          />
        )}

        {isConfirmStep && <ConfirmReview fields={confirmFields} />}
      </Panel>
    </Screen>
  );
}
