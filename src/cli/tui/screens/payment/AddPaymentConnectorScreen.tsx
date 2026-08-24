import { PaymentConnectorNameSchema } from '../../../../schema';
import {
  validateApiKeySecret,
  validateAuthorizationPrivateKey,
  validateWalletSecret,
} from '../../../primitives/payment-validation';
import { ConfirmReview, Panel, Screen, SecretInput, StepIndicator, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddPaymentConnectorConfig, PaymentConnectorSetup } from './types';
import { CONNECTOR_STEP_LABELS, PAYMENT_CONNECTOR_SETUP_OPTIONS } from './types';
import { useAddPaymentConnectorWizard } from './useAddPaymentWizard';
import React, { useMemo } from 'react';

interface AddPaymentConnectorScreenProps {
  onComplete: (config: AddPaymentConnectorConfig) => void;
  onExit: () => void;
  existingManagerNames: string[];
  existingConnectorNames: string[];
  preSelectedManager?: string;
  headerContent?: React.ReactNode;
  /** When true, skip the confirm step and call onComplete after connector name */
  skipConfirm?: boolean;
  /** Called when user selects a manager (for parent to refresh connector names) */
  onManagerSelected?: (managerName: string) => void;
}

export function AddPaymentConnectorScreen({
  onComplete,
  onExit,
  existingManagerNames,
  existingConnectorNames,
  preSelectedManager,
  headerContent: externalHeader,
  skipConfirm = false,
  onManagerSelected,
}: AddPaymentConnectorScreenProps) {
  const wizard = useAddPaymentConnectorWizard(preSelectedManager);

  const managerItems: SelectableItem[] = useMemo(
    () =>
      existingManagerNames.map(name => ({
        id: name,
        title: name,
        description: 'Payment manager',
      })),
    [existingManagerNames]
  );

  const setupItems: SelectableItem[] = useMemo(
    () => PAYMENT_CONNECTOR_SETUP_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const isManagerSelectStep = wizard.step === 'manager-select';
  const isSetupStep = wizard.step === 'setup-select';
  const isApiKeyIdStep = wizard.step === 'api-key-id';
  const isApiKeySecretStep = wizard.step === 'api-key-secret';
  const isWalletSecretStep = wizard.step === 'wallet-secret';
  const isAppIdStep = wizard.step === 'app-id';
  const isAppSecretStep = wizard.step === 'app-secret';
  const isAuthorizationPrivateKeyStep = wizard.step === 'authorization-private-key';
  const isAuthorizationIdStep = wizard.step === 'authorization-id';
  const isConnectorNameStep = wizard.step === 'connector-name';
  const isConfirmStep = wizard.step === 'confirm';

  const managerNav = useListNavigation({
    items: managerItems,
    onSelect: item => {
      wizard.setManagerName(item.id);
      onManagerSelected?.(item.id);
    },
    onExit: () => onExit(),
    isActive: isManagerSelectStep,
  });

  const setupNav = useListNavigation({
    items: setupItems,
    onSelect: item => wizard.setSetup(item.id as PaymentConnectorSetup),
    onExit: () => {
      if (wizard.currentIndex === 0) {
        onExit();
      } else {
        wizard.goBack();
      }
    },
    isActive: isSetupStep,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const helpText =
    isManagerSelectStep || isSetupStep
      ? HELP_TEXT.NAVIGATE_SELECT
      : isConfirmStep
        ? HELP_TEXT.CONFIRM_CANCEL
        : HELP_TEXT.TEXT_INPUT;

  const headerContent = externalHeader ?? (
    <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={CONNECTOR_STEP_LABELS} />
  );

  const defaultConnectorName = generateUniqueName(
    wizard.config.provider === 'StripePrivy' ? 'MyStripePrivyConnector' : 'MyCdpConnector',
    existingConnectorNames
  );

  const isFirstStep = wizard.currentIndex === 0;
  const goBackOrExit = isFirstStep ? onExit : () => wizard.goBack();

  return (
    <Screen title="Add Payment Connector" onExit={goBackOrExit} helpText={helpText} headerContent={headerContent}>
      <Panel>
        {isManagerSelectStep && (
          <WizardSelect
            title="Select payment manager"
            description="Which manager should this connector be added to?"
            items={managerItems}
            selectedIndex={managerNav.selectedIndex}
          />
        )}

        {isSetupStep && (
          <WizardSelect
            title="Choose connector setup"
            description="Select how the connector should obtain credentials"
            items={setupItems}
            selectedIndex={setupNav.selectedIndex}
          />
        )}

        {isApiKeyIdStep && (
          <SecretInput
            key="api-key-id"
            prompt="CDP API Key ID"
            onSubmit={wizard.setApiKeyId}
            onCancel={goBackOrExit}
            customValidation={value => value.trim().length > 0 || 'API Key ID is required'}
            revealChars={4}
          />
        )}

        {isApiKeySecretStep && (
          <SecretInput
            key="api-key-secret"
            prompt="CDP API Key Secret"
            onSubmit={wizard.setApiKeySecret}
            onCancel={goBackOrExit}
            customValidation={validateApiKeySecret}
            revealChars={4}
          />
        )}

        {isWalletSecretStep && (
          <SecretInput
            key="wallet-secret"
            prompt="CDP Wallet Secret"
            onSubmit={wizard.setWalletSecret}
            onCancel={goBackOrExit}
            customValidation={validateWalletSecret}
            revealChars={4}
          />
        )}

        {isAppIdStep && (
          <SecretInput
            key="app-id"
            prompt="Privy App ID"
            onSubmit={wizard.setAppId}
            onCancel={goBackOrExit}
            customValidation={value => value.trim().length > 0 || 'App ID is required'}
            revealChars={4}
          />
        )}

        {isAppSecretStep && (
          <SecretInput
            key="app-secret"
            prompt="Privy App Secret"
            onSubmit={wizard.setAppSecret}
            onCancel={goBackOrExit}
            customValidation={value => value.trim().length > 0 || 'App Secret is required'}
            revealChars={4}
          />
        )}

        {isAuthorizationPrivateKeyStep && (
          <SecretInput
            key="authorization-private-key"
            prompt="Authorization Private Key (ECDSA P-256)"
            onSubmit={wizard.setAuthorizationPrivateKey}
            onCancel={goBackOrExit}
            customValidation={validateAuthorizationPrivateKey}
            revealChars={4}
          />
        )}

        {isAuthorizationIdStep && (
          <SecretInput
            key="authorization-id"
            prompt="Authorization ID"
            onSubmit={wizard.setAuthorizationId}
            onCancel={goBackOrExit}
            customValidation={value => value.trim().length > 0 || 'Authorization ID is required'}
            revealChars={4}
          />
        )}

        {isConnectorNameStep && (
          <TextInput
            key="connector-name"
            prompt="Connector name"
            initialValue={defaultConnectorName}
            onSubmit={name => {
              if (skipConfirm) {
                onComplete({ ...wizard.config, connectorName: name });
              } else {
                wizard.setConnectorName(name);
              }
            }}
            onCancel={goBackOrExit}
            schema={PaymentConnectorNameSchema}
            customValidation={value =>
              !existingConnectorNames.includes(value) || 'Connector name already exists in this manager'
            }
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Manager', value: wizard.config.managerName },
              {
                label: 'Provisioning',
                value: wizard.config.provisionMode === 'QUICK_CREATE' ? 'Quick Create' : 'Manual',
              },
              {
                label: 'Provider',
                value: wizard.config.provider === 'StripePrivy' ? 'Stripe + Privy' : 'Coinbase CDP',
              },
              { label: 'Connector Name', value: wizard.config.connectorName },
              ...(wizard.config.provisionMode === 'QUICK_CREATE'
                ? []
                : wizard.config.provider === 'StripePrivy'
                  ? [
                      {
                        label: 'App ID',
                        value: wizard.config.appId
                          ? wizard.config.appId.length > 8
                            ? '****' + wizard.config.appId.slice(-4)
                            : '••••••••'
                          : '',
                      },
                      {
                        label: 'App Secret',
                        value: wizard.config.appSecret
                          ? wizard.config.appSecret.length > 8
                            ? '****' + wizard.config.appSecret.slice(-4)
                            : '••••••••'
                          : '',
                      },
                      {
                        label: 'Authorization Private Key',
                        value: wizard.config.authorizationPrivateKey
                          ? wizard.config.authorizationPrivateKey.length > 8
                            ? '****' + wizard.config.authorizationPrivateKey.slice(-4)
                            : '••••••••'
                          : '',
                      },
                      {
                        label: 'Authorization ID',
                        value: wizard.config.authorizationId
                          ? wizard.config.authorizationId.length > 8
                            ? '****' + wizard.config.authorizationId.slice(-4)
                            : '••••••••'
                          : '',
                      },
                    ]
                  : [
                      {
                        label: 'API Key ID',
                        value: wizard.config.apiKeyId
                          ? wizard.config.apiKeyId.length > 8
                            ? '****' + wizard.config.apiKeyId.slice(-4)
                            : '••••••••'
                          : '',
                      },
                      {
                        label: 'API Key Secret',
                        value: wizard.config.apiKeySecret
                          ? wizard.config.apiKeySecret.length > 8
                            ? '****' + wizard.config.apiKeySecret.slice(-4)
                            : '••••••••'
                          : '',
                      },
                      {
                        label: 'Wallet Secret',
                        value: wizard.config.walletSecret
                          ? wizard.config.walletSecret.length > 8
                            ? '****' + wizard.config.walletSecret.slice(-4)
                            : '••••••••'
                          : '',
                      },
                    ]),
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}
