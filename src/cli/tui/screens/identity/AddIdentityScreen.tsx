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
  initialType?: CredentialType;
}

export function AddIdentityScreen({ onComplete, onExit, existingIdentityNames, initialType }: AddIdentityScreenProps) {
  const wizard = useAddIdentityWizard(initialType);

  const typeItems: SelectableItem[] = useMemo(
    () => IDENTITY_TYPE_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const isTypeStep = wizard.step === 'type';
  const isNameStep = wizard.step === 'name';
  const isApiKeyStep = wizard.step === 'apiKey';
  const isDiscoveryUrlStep = wizard.step === 'discoveryUrl';
  const isClientIdStep = wizard.step === 'clientId';
  const isClientSecretStep = wizard.step === 'clientSecret';
  const isScopesStep = wizard.step === 'scopes';
  const isConfirmStep = wizard.step === 'confirm';
  const isOAuth = wizard.config.identityType === 'OAuthCredentialProvider';

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

  const defaultName = isOAuth
    ? generateUniqueName('MyOAuth', existingIdentityNames)
    : generateUniqueName('MyApiKey', existingIdentityNames);

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
            initialValue={defaultName}
            onSubmit={wizard.setName}
            onCancel={() => wizard.goBack()}
            schema={CredentialNameSchema}
            customValidation={value => !existingIdentityNames.includes(value) || 'Credential name already exists'}
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

        {isDiscoveryUrlStep && (
          <TextInput
            key="discoveryUrl"
            prompt="Discovery URL (OIDC well-known endpoint)"
            placeholder="https://example.com/.well-known/openid-configuration"
            onSubmit={wizard.setDiscoveryUrl}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              try {
                new URL(value);
              } catch {
                return 'Must be a valid URL';
              }
              if (!value.endsWith('/.well-known/openid-configuration')) {
                return "URL must end with '/.well-known/openid-configuration'";
              }
              return true;
            }}
          />
        )}

        {isClientIdStep && (
          <SecretInput
            key="clientId"
            prompt="Client ID"
            onSubmit={wizard.setClientId}
            onCancel={() => wizard.goBack()}
            customValidation={value => value.trim().length > 0 || 'Client ID is required'}
            revealChars={4}
          />
        )}

        {isClientSecretStep && (
          <SecretInput
            key="clientSecret"
            prompt="Client Secret"
            onSubmit={wizard.setClientSecret}
            onCancel={() => wizard.goBack()}
            customValidation={value => value.trim().length > 0 || 'Client secret is required'}
            revealChars={4}
          />
        )}

        {isScopesStep && (
          <TextInput
            key="scopes"
            prompt="Scopes (comma-separated, optional)"
            placeholder="press Enter to skip"
            initialValue=""
            onSubmit={wizard.setScopes}
            onCancel={() => wizard.goBack()}
            allowEmpty
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={
              isOAuth
                ? [
                    { label: 'Type', value: 'OAuth' },
                    { label: 'Name', value: wizard.config.name },
                    { label: 'Discovery URL', value: wizard.config.discoveryUrl ?? '' },
                    {
                      label: 'Client ID',
                      value: wizard.config.clientId ? '****' + wizard.config.clientId.slice(-4) : '',
                    },
                    ...(wizard.config.scopes ? [{ label: 'Scopes', value: wizard.config.scopes }] : []),
                  ]
                : [
                    { label: 'Type', value: 'API Key' },
                    { label: 'Name', value: wizard.config.name },
                    { label: 'API Key', value: '*'.repeat(Math.min(wizard.config.apiKey.length, 20)) },
                  ]
            }
          />
        )}
      </Panel>
    </Screen>
  );
}
