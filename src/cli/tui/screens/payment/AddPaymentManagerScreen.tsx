import type { PaymentAuthorizerType } from '../../../../schema';
import { PaymentManagerNameSchema } from '../../../../schema';
import { Panel, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddPaymentManagerConfig } from './types';
import {
  AUTH_TYPE_OPTIONS,
  AUTO_PAYMENT_ITEM_ID,
  MANAGER_STEP_LABELS,
  NETWORK_PREFS_ITEM_ID,
  TOOL_ALLOWLIST_ITEM_ID,
} from './types';
import { useAddPaymentManagerWizard } from './useAddPaymentWizard';
import { Box, Text } from 'ink';
import React, { useMemo, useRef, useState } from 'react';

interface AddPaymentManagerScreenProps {
  onComplete: (config: AddPaymentManagerConfig) => void;
  onExit: () => void;
  existingManagerNames: string[];
  headerContent?: React.ReactNode;
}

export function AddPaymentManagerScreen({
  onComplete,
  onExit,
  existingManagerNames,
  headerContent: externalHeader,
}: AddPaymentManagerScreenProps) {
  const wizard = useAddPaymentManagerWizard();

  const authTypeItems: SelectableItem[] = useMemo(
    () => AUTH_TYPE_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const BUDGET_ITEM_ID = 'default-budget';
  const advancedConfigItems: SelectableItem[] = useMemo(
    () => [
      { id: AUTO_PAYMENT_ITEM_ID, title: 'Auto Payment' },
      { id: BUDGET_ITEM_ID, title: `Edit Default Budget (Current: $${wizard.config.defaultSpendLimit})` },
      { id: TOOL_ALLOWLIST_ITEM_ID, title: 'Edit Tool Allowlist' },
      { id: NETWORK_PREFS_ITEM_ID, title: 'Edit Network Preferences' },
    ],
    [wizard.config.defaultSpendLimit]
  );

  const INITIAL_ADVANCED_SELECTED = [AUTO_PAYMENT_ITEM_ID];

  // Advanced config sub-steps: 0 = multi-select, 1 = budget, 2 = tool allowlist, 3 = network prefs
  const [advancedSubStep, setAdvancedSubStep] = useState(0);
  const [pendingSubSteps, setPendingSubSteps] = useState<number[]>([]);
  const [prevWizardStep, setPrevWizardStep] = useState(wizard.step);
  if (prevWizardStep !== wizard.step) {
    setPrevWizardStep(wizard.step);
    if (wizard.step === 'advanced-config') {
      setAdvancedSubStep(0);
      setPendingSubSteps([]);
    }
  }

  const isAuthTypeStep = wizard.step === 'auth-type';
  const isDiscoveryUrlStep = wizard.step === 'discovery-url';
  const isAllowedClientsStep = wizard.step === 'allowed-clients';
  const isAllowedAudienceStep = wizard.step === 'allowed-audience';
  const isAllowedScopesStep = wizard.step === 'allowed-scopes';
  const isManagerNameStep = wizard.step === 'manager-name';
  const isAdvancedConfigStep = wizard.step === 'advanced-config';

  const authTypeNav = useListNavigation({
    items: authTypeItems,
    onSelect: item => wizard.setAuthorizerType(item.id as PaymentAuthorizerType),
    onExit: () => onExit(),
    isActive: isAuthTypeStep,
  });

  const [autoPaymentEnabled, setAutoPaymentEnabled] = useState(true);
  const resolvedValuesRef = useRef({
    autoPayment: true,
    defaultSpendLimit: wizard.config.defaultSpendLimit,
    paymentToolAllowlist: wizard.config.paymentToolAllowlist,
    networkPreferences: wizard.config.networkPreferences,
  });

  const advanceToNextSubStepOrComplete = (queue: number[]) => {
    if (queue.length > 0) {
      const [next, ...rest] = queue;
      setPendingSubSteps(rest);
      setAdvancedSubStep(next!);
    } else {
      onComplete({
        ...wizard.config,
        autoPayment: resolvedValuesRef.current.autoPayment,
        defaultSpendLimit: resolvedValuesRef.current.defaultSpendLimit,
        paymentToolAllowlist: resolvedValuesRef.current.paymentToolAllowlist,
        networkPreferences: resolvedValuesRef.current.networkPreferences,
      });
    }
  };

  const advancedNav = useMultiSelectNavigation({
    items: advancedConfigItems,
    getId: item => item.id,
    initialSelectedIds: INITIAL_ADVANCED_SELECTED,
    onConfirm: selectedIds => {
      const autoEnabled = selectedIds.includes(AUTO_PAYMENT_ITEM_ID);
      setAutoPaymentEnabled(autoEnabled);
      resolvedValuesRef.current.autoPayment = autoEnabled;
      const queue: number[] = [];
      if (selectedIds.includes(BUDGET_ITEM_ID)) queue.push(1);
      if (selectedIds.includes(TOOL_ALLOWLIST_ITEM_ID)) queue.push(2);
      if (selectedIds.includes(NETWORK_PREFS_ITEM_ID)) queue.push(3);
      advanceToNextSubStepOrComplete(queue);
    },
    onExit: () => wizard.goBack(),
    isActive: isAdvancedConfigStep && advancedSubStep === 0,
    requireSelection: false,
  });

  const helpText = isAdvancedConfigStep
    ? advancedSubStep === 0
      ? 'Space toggle · Enter confirm · Esc back'
      : HELP_TEXT.TEXT_INPUT
    : isAuthTypeStep
      ? HELP_TEXT.NAVIGATE_SELECT
      : HELP_TEXT.TEXT_INPUT;

  const headerContent = externalHeader ?? (
    <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={MANAGER_STEP_LABELS} />
  );

  const defaultManagerName = generateUniqueName('MyPaymentManager', existingManagerNames);

  const isFirstStep = wizard.currentIndex === 0;
  const goBackOrExit = isFirstStep ? onExit : () => wizard.goBack();

  return (
    <Screen title="Add Payment Manager" onExit={goBackOrExit} helpText={helpText} headerContent={headerContent}>
      <Panel>
        {isAuthTypeStep && (
          <WizardSelect
            title="Select authorization type"
            description="How users authenticate to the payment manager"
            items={authTypeItems}
            selectedIndex={authTypeNav.selectedIndex}
          />
        )}

        {isDiscoveryUrlStep && (
          <TextInput
            key="discovery-url"
            prompt="OIDC Discovery URL"
            initialValue=""
            onSubmit={wizard.setDiscoveryUrl}
            onCancel={goBackOrExit}
            customValidation={value => {
              if (!value.trim()) return 'Discovery URL is required for Custom JWT';
              try {
                new URL(value.trim());
                return true;
              } catch {
                return 'Must be a valid URL';
              }
            }}
          />
        )}

        {isAllowedClientsStep && (
          <TextInput
            key="allowed-clients"
            prompt="Allowed client IDs (comma-separated, leave empty to skip)"
            initialValue=""
            onSubmit={wizard.setAllowedClients}
            onCancel={goBackOrExit}
          />
        )}

        {isAllowedAudienceStep && (
          <TextInput
            key="allowed-audience"
            prompt="Allowed audiences (comma-separated, leave empty to skip)"
            initialValue=""
            onSubmit={wizard.setAllowedAudience}
            onCancel={goBackOrExit}
          />
        )}

        {isAllowedScopesStep && (
          <TextInput
            key="allowed-scopes"
            prompt="Allowed scopes (comma-separated, leave empty to skip)"
            initialValue=""
            onSubmit={wizard.setAllowedScopes}
            onCancel={goBackOrExit}
          />
        )}

        {isManagerNameStep && (
          <TextInput
            key="manager-name"
            prompt="Payment manager name"
            initialValue={defaultManagerName}
            onSubmit={wizard.setManagerName}
            onCancel={goBackOrExit}
            schema={PaymentManagerNameSchema}
            customValidation={value => !existingManagerNames.includes(value) || 'Payment manager name already exists'}
          />
        )}

        {isAdvancedConfigStep && advancedSubStep === 0 && (
          <Box flexDirection="column">
            <Text bold>Advanced Configuration</Text>
            <Text dimColor>Space toggle · Enter continue · Esc back</Text>
            <Box marginTop={1} flexDirection="column">
              {advancedConfigItems.map((item, idx) => {
                const isCursor = idx === advancedNav.cursorIndex;
                const isChecked = advancedNav.selectedIds.has(item.id);
                const checkbox = isChecked ? '[✓]' : '[ ]';
                return (
                  <Box key={item.id}>
                    <Text wrap="truncate">
                      <Text color={isCursor ? 'cyan' : undefined}>{isCursor ? '❯' : ' '} </Text>
                      <Text color={isChecked ? 'green' : undefined}>{checkbox} </Text>
                      <Text color={isCursor ? 'cyan' : undefined}>{item.title}</Text>
                    </Text>
                    <Text dimColor> {isChecked ? 'Enabled' : 'Disabled'}</Text>
                  </Box>
                );
              })}
            </Box>
            <Box marginTop={1}>
              <Text dimColor>Toggle items with Space. Press Enter to continue.</Text>
            </Box>
          </Box>
        )}

        {isAdvancedConfigStep && advancedSubStep === 1 && (
          <Box flexDirection="column">
            <Text bold>Advanced Configuration</Text>
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Auto Payment: {autoPaymentEnabled ? '✓ Enabled' : '✗ Disabled'}</Text>
            </Box>
            <Box marginTop={1}>
              <TextInput
                key="default-spend-limit"
                prompt="Default Spend Limit (USD)"
                initialValue={wizard.config.defaultSpendLimit}
                onSubmit={value => {
                  const resolved = value || '10.00';
                  resolvedValuesRef.current.defaultSpendLimit = resolved;
                  wizard.setDefaultSpendLimit(value);
                  advanceToNextSubStepOrComplete(pendingSubSteps);
                }}
                onCancel={() => setAdvancedSubStep(0)}
                customValidation={value => {
                  if (!value.trim()) return true;
                  const num = Number(value.trim());
                  if (Number.isNaN(num) || num < 0) return 'Must be a valid positive number';
                  return true;
                }}
              />
            </Box>
            <Box marginTop={1}>
              <Text dimColor>
                Used only for sessions created by `invoke --auto-session`. It is not a deployed-agent budget — sessions
                your agent creates at runtime set their own limit.
              </Text>
            </Box>
          </Box>
        )}

        {isAdvancedConfigStep && advancedSubStep === 2 && (
          <Box flexDirection="column">
            <Text bold>Advanced Configuration</Text>
            <Box marginTop={1}>
              <TextInput
                key="tool-allowlist"
                prompt="Tool Allowlist (comma-separated, leave empty to allow all)"
                initialValue={wizard.config.paymentToolAllowlist ?? ''}
                onSubmit={value => {
                  const resolved = value.trim() || undefined;
                  resolvedValuesRef.current.paymentToolAllowlist = resolved;
                  wizard.setPaymentToolAllowlist(resolved);
                  advanceToNextSubStepOrComplete(pendingSubSteps);
                }}
                onCancel={() => setAdvancedSubStep(0)}
              />
            </Box>
          </Box>
        )}

        {isAdvancedConfigStep && advancedSubStep === 3 && (
          <Box flexDirection="column">
            <Text bold>Advanced Configuration</Text>
            <Box marginTop={1}>
              <TextInput
                key="network-preferences"
                prompt="Network Preferences (comma-separated, e.g. eip155:84532)"
                initialValue={wizard.config.networkPreferences ?? ''}
                onSubmit={value => {
                  const resolved = value.trim() || undefined;
                  resolvedValuesRef.current.networkPreferences = resolved;
                  wizard.setNetworkPreferences(resolved);
                  advanceToNextSubStepOrComplete(pendingSubSteps);
                }}
                onCancel={() => setAdvancedSubStep(0)}
              />
            </Box>
          </Box>
        )}
      </Panel>
    </Screen>
  );
}
