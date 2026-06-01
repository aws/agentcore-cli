import type { DatasetSchemaType } from '../../../../schema';
import { DatasetNameSchema, isValidKmsKeyArn } from '../../../../schema';
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
  kmsKeyArn?: string;
}

type Step = 'name' | 'schema-type' | 'description' | 'kms-key' | 'confirm';

const STEP_LABELS: Record<Step, string> = {
  name: 'Name',
  'schema-type': 'Schema Type',
  description: 'Description',
  'kms-key': 'KMS Key',
  confirm: 'Confirm',
};

const STEPS: Step[] = ['name', 'schema-type', 'description', 'kms-key', 'confirm'];

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
  const [kmsKeyArn, setKmsKeyArn] = useState('');

  const isNameStep = step === 'name';
  const isSchemaTypeStep = step === 'schema-type';
  const isDescriptionStep = step === 'description';
  const isKmsKeyStep = step === 'kms-key';
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
    onSelect: () =>
      onComplete({ name, schemaType, description: description || undefined, kmsKeyArn: kmsKeyArn || undefined }),
    onExit: () => setStep('kms-key'),
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
      ...(kmsKeyArn ? [{ label: 'KMS Key', value: kmsKeyArn }] : []),
    ],
    [name, schemaType, description, kmsKeyArn]
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
            initialValue={name || generateUniqueName('MyDataset', existingDatasetNames)}
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
            initialValue={description}
            onSubmit={(value: string) => {
              setDescription(value);
              setStep('kms-key');
            }}
            onCancel={() => setStep('schema-type')}
            allowEmpty
          />
        )}

        {isKmsKeyStep && (
          <TextInput
            key="kms-key"
            prompt="KMS Key ARN (optional, press Enter to skip)"
            initialValue={kmsKeyArn}
            onSubmit={(value: string) => {
              setKmsKeyArn(value);
              setStep('confirm');
            }}
            onCancel={() => setStep('description')}
            allowEmpty
            customValidation={value => !value || isValidKmsKeyArn(value) || 'Must be a valid KMS key ARN'}
          />
        )}

        {isConfirmStep && <ConfirmReview fields={confirmFields} />}
      </Panel>
    </Screen>
  );
}
