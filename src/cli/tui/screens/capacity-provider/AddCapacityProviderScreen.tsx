import type { OperatingSystem } from '../../../../schema';
import { CapacityProviderNameSchema, isValidOperatorRoleArn } from '../../../../schema';
import { ConfirmReview, Panel, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import React, { useMemo, useState } from 'react';

const OS_OPTIONS: SelectableItem[] = [
  { id: 'LINUX_X86_64', title: 'Linux x86_64', description: 'Intel/AMD 64-bit Linux instances' },
  { id: 'LINUX_ARM64', title: 'Linux ARM64', description: 'Graviton/ARM 64-bit Linux instances' },
];

export interface AddCapacityProviderConfig {
  name: string;
  operatorRoleArn?: string;
  description?: string;
  subnets: string;
  securityGroups: string;
  os: OperatingSystem;
  instanceTypes: string;
}

type Step =
  | 'name'
  | 'operator-role'
  | 'subnets'
  | 'security-groups'
  | 'os'
  | 'instance-types'
  | 'description'
  | 'confirm';

const STEP_LABELS: Record<Step, string> = {
  name: 'Name',
  'operator-role': 'Operator Role',
  subnets: 'Subnets',
  'security-groups': 'Security Groups',
  os: 'OS',
  'instance-types': 'Instance Types',
  description: 'Description',
  confirm: 'Confirm',
};

const STEPS: Step[] = [
  'name',
  'operator-role',
  'subnets',
  'security-groups',
  'os',
  'instance-types',
  'description',
  'confirm',
];

const SUBNET_PATTERN = /^subnet-[0-9a-zA-Z]{8,17}$/;
const SECURITY_GROUP_PATTERN = /^sg-[0-9a-zA-Z]{8,17}$/;

function splitList(value: string): string[] {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

interface AddCapacityProviderScreenProps {
  onComplete: (config: AddCapacityProviderConfig) => void;
  onExit: () => void;
  existingNames: string[];
}

export function AddCapacityProviderScreen({ onComplete, onExit, existingNames }: AddCapacityProviderScreenProps) {
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [operatorRoleArn, setOperatorRoleArn] = useState('');
  const [subnets, setSubnets] = useState('');
  const [securityGroups, setSecurityGroups] = useState('');
  const [os, setOs] = useState<OperatingSystem>('LINUX_X86_64');
  const [instanceTypes, setInstanceTypes] = useState('');
  const [description, setDescription] = useState('');

  const isNameStep = step === 'name';
  const isOperatorRoleStep = step === 'operator-role';
  const isSubnetsStep = step === 'subnets';
  const isSecurityGroupsStep = step === 'security-groups';
  const isOsStep = step === 'os';
  const isInstanceTypesStep = step === 'instance-types';
  const isDescriptionStep = step === 'description';
  const isConfirmStep = step === 'confirm';

  const osNav = useListNavigation({
    items: OS_OPTIONS,
    isActive: isOsStep,
    onSelect: (item: SelectableItem) => {
      setOs(item.id as OperatingSystem);
      setStep('instance-types');
    },
    onExit: () => setStep('security-groups'),
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () =>
      onComplete({
        name,
        operatorRoleArn: operatorRoleArn || undefined,
        subnets,
        securityGroups,
        os,
        instanceTypes,
        description: description || undefined,
      }),
    onExit: () => setStep('description'),
    isActive: isConfirmStep,
  });

  const helpText = isOsStep
    ? HELP_TEXT.NAVIGATE_SELECT
    : isConfirmStep
      ? HELP_TEXT.CONFIRM_CANCEL
      : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={STEPS} currentStep={step} labels={STEP_LABELS} />;

  const confirmFields = useMemo(
    () => [
      { label: 'Name', value: name },
      { label: 'Operator Role ARN', value: operatorRoleArn || '(auto-created)' },
      { label: 'Subnets', value: splitList(subnets).join(', ') },
      { label: 'Security Groups', value: splitList(securityGroups).join(', ') },
      { label: 'OS', value: os },
      { label: 'Instance Types', value: splitList(instanceTypes).join(', ') },
      ...(description ? [{ label: 'Description', value: description }] : []),
    ],
    [name, operatorRoleArn, subnets, securityGroups, os, instanceTypes, description]
  );

  return (
    <Screen
      title="Add Capacity Provider"
      onExit={onExit}
      helpText={helpText}
      headerContent={headerContent}
      exitEnabled={isNameStep}
    >
      <Panel>
        {isNameStep && (
          <TextInput
            key="name"
            prompt="Capacity provider name"
            initialValue={name || generateUniqueName('MyCapacityProvider', existingNames)}
            onSubmit={(value: string) => {
              setName(value);
              setStep('operator-role');
            }}
            onCancel={onExit}
            schema={CapacityProviderNameSchema}
            customValidation={value => !existingNames.includes(value) || 'Capacity provider name already exists'}
          />
        )}

        {isOperatorRoleStep && (
          <TextInput
            key="operator-role"
            prompt="Operator role ARN (optional, press Enter to auto-create)"
            initialValue={operatorRoleArn}
            onSubmit={(value: string) => {
              setOperatorRoleArn(value);
              setStep('subnets');
            }}
            onCancel={() => setStep('name')}
            allowEmpty
            customValidation={value =>
              value.trim() === '' || isValidOperatorRoleArn(value) || 'Must be a valid IAM role ARN'
            }
          />
        )}

        {isSubnetsStep && (
          <TextInput
            key="subnets"
            prompt="Subnet IDs (comma-separated, 1-16)"
            initialValue={subnets}
            onSubmit={(value: string) => {
              setSubnets(value);
              setStep('security-groups');
            }}
            onCancel={() => setStep('operator-role')}
            customValidation={value => {
              const ids = splitList(value);
              if (ids.length < 1 || ids.length > 16) return 'Provide 1-16 subnet IDs';
              return ids.every(id => SUBNET_PATTERN.test(id)) || 'Each must be a valid subnet ID (subnet-...)';
            }}
          />
        )}

        {isSecurityGroupsStep && (
          <TextInput
            key="security-groups"
            prompt="Security group IDs (comma-separated, 1-16)"
            initialValue={securityGroups}
            onSubmit={(value: string) => {
              setSecurityGroups(value);
              setStep('os');
            }}
            onCancel={() => setStep('subnets')}
            customValidation={value => {
              const ids = splitList(value);
              if (ids.length < 1 || ids.length > 16) return 'Provide 1-16 security group IDs';
              return (
                ids.every(id => SECURITY_GROUP_PATTERN.test(id)) || 'Each must be a valid security group ID (sg-...)'
              );
            }}
          />
        )}

        {isOsStep && (
          <WizardSelect
            title="Operating system"
            description="CPU architecture for the capacity provider instances"
            items={OS_OPTIONS}
            selectedIndex={osNav.selectedIndex}
          />
        )}

        {isInstanceTypesStep && (
          <TextInput
            key="instance-types"
            prompt="Allowed EC2 instance types (comma-separated, 1-30)"
            initialValue={instanceTypes}
            onSubmit={(value: string) => {
              setInstanceTypes(value);
              setStep('description');
            }}
            onCancel={() => setStep('os')}
            customValidation={value => {
              const types = splitList(value);
              return (types.length >= 1 && types.length <= 30) || 'Provide 1-30 instance types';
            }}
          />
        )}

        {isDescriptionStep && (
          <TextInput
            key="description"
            prompt="Description (optional, press Enter to skip)"
            initialValue={description}
            onSubmit={(value: string) => {
              setDescription(value);
              setStep('confirm');
            }}
            onCancel={() => setStep('instance-types')}
            allowEmpty
          />
        )}

        {isConfirmStep && <ConfirmReview fields={confirmFields} />}
      </Panel>
    </Screen>
  );
}
