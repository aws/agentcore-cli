import type { CredentialType } from '../../../../schema';
import { CredentialNameSchema } from '../../../../schema';
import { ConfirmReview, Panel, Screen, SecretInput, StepIndicator, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddIdentityConfig } from './types';
import { IDENTITY_STEP_LABELS, IDENTITY_TYPE_OPTIONS } from './types';
import { useAddIdentityWizard } from './useAddIdentityWizard';
import React, { useMemo } from 'react';

interface AddIdentityScreenProps {
  onComplete: (config: AddIdentityConfig) => void;
  onExit: () => void;
  existingIdentityNames: string[];
}

export function AddIdentityScreen({ onComplete, onExit, existingIdentityNames }: AddIdentityScreenProps) {
  const wizard = useAddIdentityWizard();

  const typeItems: SelectableItem[] = useMemo(
    () => IDENTITY_TYPE_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const isTypeStep = wizard.step === 'type';
  const isNameStep = wizard.step === 'name';
  const isApiKeyStep = wizard.step === 'apiKey';
  const isConfirmStep = wizard.step === 'confirm';

  const typeNav = useListNavigation({
    items: typeItems,
    onSelect: item => wizard.setIdentityType(item.id as CredentialType),
    onExit: () => onExit(),
    isActive: isTypeStep,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const helpText = isTypeStep
    ? HELP_TEXT.NAVIGATE_SELECT
    : isConfirmStep
      ? HELP_TEXT.CONFIRM_CANCEL
      : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={IDENTITY_STEP_LABELS} />;

  return (
    <Screen title="Add Credential" onExit={onExit} helpText={helpText} headerContent={headerContent}>
      <Panel>
        {isTypeStep && (
          <WizardSelect
            title="Select credential type"
            description="Choose the type of credential provider"
            items={typeItems}
            selectedIndex={typeNav.selectedIndex}
          />
        )}

        {isNameStep && (
          <TextInput
            key="name"
            prompt="Credential name"
            initialValue={generateUniqueName('MyApiKey', existingIdentityNames)}
            onSubmit={wizard.setName}
            onCancel={() => wizard.goBack()}
            schema={CredentialNameSchema}
          />
        )}

        {isApiKeyStep && (
          <SecretInput
            key="apiKey"
            prompt="API Key"
            onSubmit={wizard.setApiKey}
            onCancel={() => wizard.goBack()}
            customValidation={value => value.trim().length > 0 || 'API key is required'}
            revealChars={4}
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Type', value: 'API Key' },
              { label: 'Name', value: wizard.config.name },
              { label: 'API Key', value: '*'.repeat(Math.min(wizard.config.apiKey.length, 20)) },
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}
