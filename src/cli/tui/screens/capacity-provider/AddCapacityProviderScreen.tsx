import type { OperatingSystem } from '../../../../schema';
import { CapacityProviderNameSchema, isValidOperatorRoleArn } from '../../../../schema';
import { ConfirmReview, Panel, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import { Box, Text } from 'ink';
import React, { useMemo, useState } from 'react';

const OS_OPTIONS: SelectableItem[] = [
  { id: 'LINUX_X86_64', title: 'Linux x86_64', description: 'Intel/AMD 64-bit Linux instances' },
  { id: 'LINUX_ARM64', title: 'Linux ARM64', description: 'Graviton/ARM 64-bit Linux instances' },
];

const ADD_ANOTHER_OPTIONS: SelectableItem[] = [
  { id: 'yes', title: 'Yes', description: 'Add another volume' },
  { id: 'no', title: 'No', description: 'Continue' },
];

const ENCRYPTION_OPTIONS: SelectableItem[] = [
  { id: 'no', title: 'No encryption', description: 'EBS volumes are not encrypted' },
  { id: 'yes', title: 'Encrypt EBS volumes', description: 'Optionally with your own KMS key' },
];

/** A named EBS volume defined on the capacity provider. */
export interface CapacityProviderVolumeInput {
  name: string;
  sizeGiB: number;
}

export interface AddCapacityProviderConfig {
  name: string;
  operatorRoleArn?: string;
  description?: string;
  subnets: string;
  securityGroups: string;
  os: OperatingSystem;
  instanceTypes: string;
  instanceProfileArn?: string;
  volumes: CapacityProviderVolumeInput[];
  volumeEncrypted?: boolean;
  volumeKmsKey?: string;
  idleInstanceTimeout?: string;
  maxLifetime?: string;
}

type Step =
  | 'name'
  | 'operator-role'
  | 'subnets'
  | 'security-groups'
  | 'os'
  | 'instance-types'
  | 'instance-profile'
  | 'volumes'
  | 'volume-encryption'
  | 'volume-kms'
  | 'idle-timeout'
  | 'max-lifetime'
  | 'description'
  | 'confirm';

/** Sub-phase within the (single) Volumes step — an add-another loop. */
type VolumePhase = 'name' | 'size' | 'another';

const STEP_LABELS: Record<Step, string> = {
  name: 'Name',
  'operator-role': 'Operator Role',
  subnets: 'Subnets',
  'security-groups': 'Security Groups',
  os: 'OS',
  'instance-types': 'Instance Types',
  'instance-profile': 'Instance Profile',
  volumes: 'Volumes',
  'volume-encryption': 'Encryption',
  'volume-kms': 'KMS Key',
  'idle-timeout': 'Idle Timeout',
  'max-lifetime': 'Max Lifetime',
  description: 'Description',
  confirm: 'Confirm',
};

/**
 * The step sequence. Encryption is only relevant when volumes are defined, and the KMS-key step
 * only appears when encryption is enabled — so the tail is computed from current state.
 */
export function buildSteps(volumeCount: number, encrypted: boolean): Step[] {
  const steps: Step[] = [
    'name',
    'operator-role',
    'subnets',
    'security-groups',
    'os',
    'instance-types',
    'instance-profile',
    'volumes',
  ];
  if (volumeCount > 0) {
    steps.push('volume-encryption');
    if (encrypted) steps.push('volume-kms');
  }
  steps.push('idle-timeout', 'max-lifetime', 'description', 'confirm');
  return steps;
}

const SUBNET_PATTERN = /^subnet-[0-9a-zA-Z]{8,17}$/;
const SECURITY_GROUP_PATTERN = /^sg-[0-9a-zA-Z]{8,17}$/;
// Mirror the schema patterns in src/schema/schemas/primitives/capacity-provider.ts.
const INSTANCE_PROFILE_ARN_PATTERN = /^arn:[^:]+:iam::[0-9]{12}:instance-profile\/.+$/;
const KMS_KEY_ARN_PATTERN =
  /^arn:[^:]+:kms:[a-z0-9-]+:[0-9]{12}:key\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_VOLUMES = 5;
const MAX_VOLUME_SIZE_GIB = 65536;
const LIFECYCLE_SECONDS_MIN = 60;
const LIFECYCLE_SECONDS_MAX = 1209600;

function splitList(value: string): string[] {
  return value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Validate an optional whole-number lifecycle timeout (seconds). Empty is allowed (skip). */
function validateOptionalLifetime(value: string): true | string {
  const trimmed = value.trim();
  if (trimmed === '') return true;
  if (!/^[0-9]+$/.test(trimmed)) return 'Enter a whole number of seconds';
  const n = Number(trimmed);
  return (
    (n >= LIFECYCLE_SECONDS_MIN && n <= LIFECYCLE_SECONDS_MAX) ||
    `Must be between ${LIFECYCLE_SECONDS_MIN} and ${LIFECYCLE_SECONDS_MAX} seconds`
  );
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
  const [instanceProfileArn, setInstanceProfileArn] = useState('');
  const [volumes, setVolumes] = useState<CapacityProviderVolumeInput[]>([]);
  const [volumePhase, setVolumePhase] = useState<VolumePhase>('name');
  const [pendingVolumeName, setPendingVolumeName] = useState('');
  const [volumeEncrypted, setVolumeEncrypted] = useState(false);
  const [volumeKmsKey, setVolumeKmsKey] = useState('');
  const [idleTimeout, setIdleTimeout] = useState('');
  const [maxLifetime, setMaxLifetime] = useState('');
  const [description, setDescription] = useState('');

  const isNameStep = step === 'name';
  const isOperatorRoleStep = step === 'operator-role';
  const isSubnetsStep = step === 'subnets';
  const isSecurityGroupsStep = step === 'security-groups';
  const isOsStep = step === 'os';
  const isInstanceTypesStep = step === 'instance-types';
  const isInstanceProfileStep = step === 'instance-profile';
  const isVolumesStep = step === 'volumes';
  const isVolumeEncryptionStep = step === 'volume-encryption';
  const isVolumeKmsStep = step === 'volume-kms';
  const isIdleTimeoutStep = step === 'idle-timeout';
  const isMaxLifetimeStep = step === 'max-lifetime';
  const isDescriptionStep = step === 'description';
  const isConfirmStep = step === 'confirm';

  // Navigate to the step before `cur` in the (state-dependent) sequence. When that step is the
  // Volumes step, re-enter it at the review phase if volumes exist.
  const goToPrevStep = (cur: Step) => {
    const seq = buildSteps(volumes.length, volumeEncrypted);
    const prev = seq[seq.indexOf(cur) - 1] ?? 'name';
    if (prev === 'volumes') {
      setPendingVolumeName('');
      setVolumePhase(volumes.length > 0 ? 'another' : 'name');
    }
    setStep(prev);
  };

  const osNav = useListNavigation({
    items: OS_OPTIONS,
    isActive: isOsStep,
    onSelect: (item: SelectableItem) => {
      setOs(item.id as OperatingSystem);
      setStep('instance-types');
    },
    onExit: () => setStep('security-groups'),
  });

  // "Add another volume?" prompt within the Volumes step.
  const volumeAnotherNav = useListNavigation({
    items: ADD_ANOTHER_OPTIONS,
    isActive: isVolumesStep && volumePhase === 'another',
    onSelect: (item: SelectableItem) => {
      if (item.id === 'yes') {
        setPendingVolumeName('');
        setVolumePhase('name');
      } else {
        // At least one volume exists here, so encryption is the next step.
        setStep('volume-encryption');
      }
    },
    // Esc backs out of the decision to the volume-name entry (empty name finishes).
    onExit: () => {
      setPendingVolumeName('');
      setVolumePhase('name');
    },
  });

  const encryptionNav = useListNavigation({
    items: ENCRYPTION_OPTIONS,
    isActive: isVolumeEncryptionStep,
    onSelect: (item: SelectableItem) => {
      const encrypt = item.id === 'yes';
      setVolumeEncrypted(encrypt);
      if (encrypt) {
        setStep('volume-kms');
      } else {
        setVolumeKmsKey('');
        setStep('idle-timeout');
      }
    },
    onExit: () => {
      setPendingVolumeName('');
      setVolumePhase('another');
      setStep('volumes');
    },
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
        instanceProfileArn: instanceProfileArn || undefined,
        volumes,
        volumeEncrypted: volumes.length > 0 && volumeEncrypted ? true : undefined,
        volumeKmsKey: volumeEncrypted && volumeKmsKey ? volumeKmsKey : undefined,
        idleInstanceTimeout: idleTimeout || undefined,
        maxLifetime: maxLifetime || undefined,
        description: description || undefined,
      }),
    onExit: () => setStep('description'),
    isActive: isConfirmStep,
  });

  const isSelectStep = isOsStep || isVolumeEncryptionStep || (isVolumesStep && volumePhase === 'another');
  const helpText = isSelectStep
    ? HELP_TEXT.NAVIGATE_SELECT
    : isConfirmStep
      ? HELP_TEXT.CONFIRM_CANCEL
      : HELP_TEXT.TEXT_INPUT;

  const steps = useMemo(() => buildSteps(volumes.length, volumeEncrypted), [volumes.length, volumeEncrypted]);
  const headerContent = <StepIndicator steps={steps} currentStep={step} labels={STEP_LABELS} />;

  const confirmFields = useMemo(
    () => [
      { label: 'Name', value: name },
      { label: 'Operator Role ARN', value: operatorRoleArn || '(auto-created)' },
      { label: 'Subnets', value: splitList(subnets).join(', ') },
      { label: 'Security Groups', value: splitList(securityGroups).join(', ') },
      { label: 'OS', value: os },
      { label: 'Instance Types', value: splitList(instanceTypes).join(', ') },
      ...(instanceProfileArn ? [{ label: 'Instance Profile', value: instanceProfileArn }] : []),
      {
        label: 'Volumes',
        value: volumes.length ? volumes.map(v => `${v.name} (${v.sizeGiB} GiB)`).join(', ') : '(none)',
      },
      ...(volumes.length > 0
        ? [
            {
              label: 'Encryption',
              value: volumeEncrypted
                ? volumeKmsKey
                  ? `Enabled (KMS: ${volumeKmsKey})`
                  : 'Enabled (AWS-managed)'
                : 'Off',
            },
          ]
        : []),
      ...(idleTimeout ? [{ label: 'Idle Timeout', value: `${idleTimeout}s` }] : []),
      ...(maxLifetime ? [{ label: 'Max Lifetime', value: `${maxLifetime}s` }] : []),
      ...(description ? [{ label: 'Description', value: description }] : []),
    ],
    [
      name,
      operatorRoleArn,
      subnets,
      securityGroups,
      os,
      instanceTypes,
      instanceProfileArn,
      volumes,
      volumeEncrypted,
      volumeKmsKey,
      idleTimeout,
      maxLifetime,
      description,
    ]
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
              setStep('instance-profile');
            }}
            onCancel={() => setStep('os')}
            customValidation={value => {
              const types = splitList(value);
              return (types.length >= 1 && types.length <= 30) || 'Provide 1-30 instance types';
            }}
          />
        )}

        {isInstanceProfileStep && (
          <TextInput
            key="instance-profile"
            prompt="Instance profile ARN for launched instances (optional, press Enter to skip)"
            initialValue={instanceProfileArn}
            onSubmit={(value: string) => {
              setInstanceProfileArn(value.trim());
              setPendingVolumeName('');
              setVolumePhase('name');
              setStep('volumes');
            }}
            onCancel={() => setStep('instance-types')}
            allowEmpty
            customValidation={value =>
              value.trim() === '' ||
              INSTANCE_PROFILE_ARN_PATTERN.test(value.trim()) ||
              'Must be a valid IAM instance profile ARN (arn:...:instance-profile/...)'
            }
          />
        )}

        {isVolumesStep && (
          <Box flexDirection="column">
            {volumes.length > 0 && (
              <Box flexDirection="column" marginBottom={1}>
                <Text dimColor>Added volumes:</Text>
                {volumes.map(v => (
                  <Text key={v.name}>
                    {'  • '}
                    {v.name} {'  '}
                    {v.sizeGiB} GiB
                  </Text>
                ))}
              </Box>
            )}

            {volumePhase === 'name' && (
              <TextInput
                key="volume-name"
                prompt={
                  volumes.length >= MAX_VOLUMES
                    ? `Maximum of ${MAX_VOLUMES} volumes reached — press Enter to continue`
                    : 'Volume name (optional — press Enter to finish adding volumes)'
                }
                initialValue={pendingVolumeName}
                onSubmit={(value: string) => {
                  const trimmed = value.trim();
                  if (trimmed === '' || volumes.length >= MAX_VOLUMES) {
                    // Finished defining volumes — encryption applies only when volumes exist.
                    setStep(volumes.length > 0 ? 'volume-encryption' : 'idle-timeout');
                    return;
                  }
                  setPendingVolumeName(trimmed);
                  setVolumePhase('size');
                }}
                onCancel={() => setStep('instance-profile')}
                allowEmpty
                customValidation={value => {
                  const trimmed = value.trim();
                  if (trimmed === '') return true; // empty = finish
                  return volumes.every(v => v.name !== trimmed) || `Volume "${trimmed}" already added`;
                }}
              />
            )}

            {volumePhase === 'size' && (
              <TextInput
                key="volume-size"
                prompt={`Size in GiB for "${pendingVolumeName}" (1-${MAX_VOLUME_SIZE_GIB})`}
                onSubmit={(value: string) => {
                  const next = [...volumes, { name: pendingVolumeName, sizeGiB: Number(value.trim()) }];
                  setVolumes(next);
                  setPendingVolumeName('');
                  // At the max, there's nothing more to add — go straight to encryption.
                  if (next.length >= MAX_VOLUMES) {
                    setStep('volume-encryption');
                  } else {
                    setVolumePhase('another');
                  }
                }}
                onCancel={() => setVolumePhase('name')}
                customValidation={value => {
                  const trimmed = value.trim();
                  if (!/^[0-9]+$/.test(trimmed)) return 'Enter a whole number of GiB';
                  const n = Number(trimmed);
                  return (
                    (n >= 1 && n <= MAX_VOLUME_SIZE_GIB) || `Size must be between 1 and ${MAX_VOLUME_SIZE_GIB} GiB`
                  );
                }}
              />
            )}

            {volumePhase === 'another' && (
              <WizardSelect
                title="Add another volume?"
                items={ADD_ANOTHER_OPTIONS}
                selectedIndex={volumeAnotherNav.selectedIndex}
              />
            )}
          </Box>
        )}

        {isVolumeEncryptionStep && (
          <WizardSelect
            title="Encrypt EBS volumes?"
            description="Applies to all volumes on this capacity provider"
            items={ENCRYPTION_OPTIONS}
            selectedIndex={encryptionNav.selectedIndex}
          />
        )}

        {isVolumeKmsStep && (
          <TextInput
            key="volume-kms"
            prompt="KMS key ARN for volume encryption (optional, press Enter for an AWS-managed key)"
            initialValue={volumeKmsKey}
            onSubmit={(value: string) => {
              setVolumeKmsKey(value.trim());
              setStep('idle-timeout');
            }}
            onCancel={() => setStep('volume-encryption')}
            allowEmpty
            customValidation={value =>
              value.trim() === '' || KMS_KEY_ARN_PATTERN.test(value.trim()) || 'Must be a valid KMS key ARN'
            }
          />
        )}

        {isIdleTimeoutStep && (
          <TextInput
            key="idle-timeout"
            prompt={`Idle instance timeout in seconds (${LIFECYCLE_SECONDS_MIN}-${LIFECYCLE_SECONDS_MAX}, press Enter to skip)`}
            initialValue={idleTimeout}
            onSubmit={(value: string) => {
              setIdleTimeout(value.trim());
              setStep('max-lifetime');
            }}
            onCancel={() => goToPrevStep('idle-timeout')}
            allowEmpty
            customValidation={validateOptionalLifetime}
          />
        )}

        {isMaxLifetimeStep && (
          <TextInput
            key="max-lifetime"
            prompt={`Maximum instance lifetime in seconds (${LIFECYCLE_SECONDS_MIN}-${LIFECYCLE_SECONDS_MAX}, press Enter to skip)`}
            initialValue={maxLifetime}
            onSubmit={(value: string) => {
              setMaxLifetime(value.trim());
              setStep('description');
            }}
            onCancel={() => setStep('idle-timeout')}
            allowEmpty
            customValidation={validateOptionalLifetime}
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
            onCancel={() => setStep('max-lifetime')}
            allowEmpty
          />
        )}

        {isConfirmStep && <ConfirmReview fields={confirmFields} />}
      </Panel>
    </Screen>
  );
}
