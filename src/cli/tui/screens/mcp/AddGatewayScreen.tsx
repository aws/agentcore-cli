import type { GatewayAuthorizerType, PolicyEngineMode } from '../../../../schema';
import { GatewayNameSchema } from '../../../../schema';
import { computeManagedOAuthCredentialName } from '../../../primitives/credential-utils';
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
import { JwtConfigInput, useJwtConfigFlow } from '../../components/jwt-config';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddGatewayConfig } from './types';
import {
  AUTHORIZER_TYPE_OPTIONS,
  EXCEPTION_LEVEL_ITEM_ID,
  GATEWAY_STEP_LABELS,
  NONE_SELECTION,
  POLICY_ENGINE_MODE_OPTIONS,
  SEMANTIC_SEARCH_ITEM_ID,
} from './types';
import { useAddGatewayWizard } from './useAddGatewayWizard';
import { Box, Text } from 'ink';
import React, { useMemo, useState } from 'react';

interface AddGatewayScreenProps {
  onComplete: (config: AddGatewayConfig) => void;
  onExit: () => void;
  existingGateways: string[];
  unassignedTargets: string[];
  existingPolicyEngines: string[];
}

const INITIAL_ADVANCED_SELECTED = [SEMANTIC_SEARCH_ITEM_ID];

export function AddGatewayScreen({
  onComplete,
  onExit,
  existingGateways,
  unassignedTargets,
  existingPolicyEngines,
}: AddGatewayScreenProps) {
  const wizard = useAddGatewayWizard(unassignedTargets.length, existingPolicyEngines.length);

  // JWT config flow (shared hook)
  const jwtFlow = useJwtConfigFlow({
    onComplete: jwtConfig => wizard.setJwtConfig(jwtConfig),
    onBack: () => wizard.goBack(),
  });

  const unassignedTargetItems: SelectableItem[] = useMemo(
    () => unassignedTargets.map(name => ({ id: name, title: name })),
    [unassignedTargets]
  );

  const authorizerItems: SelectableItem[] = useMemo(
    () => AUTHORIZER_TYPE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const advancedConfigItems: SelectableItem[] = useMemo(
    () => [
      { id: SEMANTIC_SEARCH_ITEM_ID, title: 'Semantic Search' },
      { id: EXCEPTION_LEVEL_ITEM_ID, title: 'Debug Exception Level' },
    ],
    []
  );

  // Policy engine sub-step: 0 = select engine, 1 = select mode
  // Reset when re-entering the step (e.g., after navigating back)
  const [policyEngineSubStep, setPolicyEngineSubStep] = useState(0);
  const [selectedEngineName, setSelectedEngineName] = useState('');
  const [prevWizardStep, setPrevWizardStep] = useState(wizard.step);
  if (prevWizardStep !== wizard.step) {
    setPrevWizardStep(wizard.step);
    if (wizard.step === 'policy-engine') {
      setPolicyEngineSubStep(0);
      setSelectedEngineName('');
    }
  }

  const policyEngineItems: SelectableItem[] = useMemo(
    () => [
      { id: NONE_SELECTION, title: 'None', description: 'No policy engine' },
      ...existingPolicyEngines.map(name => ({ id: name, title: name })),
    ],
    [existingPolicyEngines]
  );

  const policyEngineModeItems: SelectableItem[] = useMemo(
    () => POLICY_ENGINE_MODE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const isNameStep = wizard.step === 'name';
  const isAuthorizerStep = wizard.step === 'authorizer';
  const isJwtConfigStep = wizard.step === 'jwt-config';
  const isIncludeTargetsStep = wizard.step === 'include-targets';
  const isPolicyEngineStep = wizard.step === 'policy-engine';
  const isAdvancedConfigStep = wizard.step === 'advanced-config';
  const isConfirmStep = wizard.step === 'confirm';

  const authorizerNav = useListNavigation({
    items: authorizerItems,
    onSelect: item => wizard.setAuthorizerType(item.id as GatewayAuthorizerType),
    onExit: () => wizard.goBack(),
    isActive: isAuthorizerStep,
  });

  const targetsNav = useMultiSelectNavigation({
    items: unassignedTargetItems,
    getId: item => item.id,
    onConfirm: ids => wizard.setSelectedTargets(ids),
    onExit: () => wizard.goBack(),
    isActive: isIncludeTargetsStep,
    requireSelection: false,
  });

  const policyEngineNav = useListNavigation({
    items: policyEngineItems,
    onSelect: item => {
      if (item.id === NONE_SELECTION) {
        wizard.skipPolicyEngine();
      } else {
        setSelectedEngineName(item.id);
        setPolicyEngineSubStep(1);
      }
    },
    onExit: () => {
      if (policyEngineSubStep === 0) {
        wizard.goBack();
      } else {
        setPolicyEngineSubStep(0);
      }
    },
    isActive: isPolicyEngineStep && policyEngineSubStep === 0,
  });

  const policyEngineModeNav = useListNavigation({
    items: policyEngineModeItems,
    onSelect: item => {
      wizard.setPolicyEngineConfig(selectedEngineName, item.id as PolicyEngineMode);
      setPolicyEngineSubStep(0);
    },
    onExit: () => setPolicyEngineSubStep(0),
    isActive: isPolicyEngineStep && policyEngineSubStep === 1,
  });

  const advancedNav = useMultiSelectNavigation({
    items: advancedConfigItems,
    getId: item => item.id,
    initialSelectedIds: INITIAL_ADVANCED_SELECTED,
    onConfirm: selectedIds =>
      wizard.setAdvancedConfig({
        enableSemanticSearch: selectedIds.includes(SEMANTIC_SEARCH_ITEM_ID),
        exceptionLevel: selectedIds.includes(EXCEPTION_LEVEL_ITEM_ID) ? 'DEBUG' : 'NONE',
      }),
    onExit: () => wizard.goBack(),
    isActive: isAdvancedConfigStep,
    requireSelection: false,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const helpText = isJwtConfigStep
    ? jwtFlow.subStep === 'constraintPicker'
      ? HELP_TEXT.MULTI_SELECT
      : jwtFlow.subStep === 'customClaims'
        ? jwtFlow.claimsManagerMode === 'add' || jwtFlow.claimsManagerMode === 'edit'
          ? '↑/↓ field · ←/→ cycle · Enter next/save · Esc cancel'
          : 'Navigate · Enter select · Esc back'
        : HELP_TEXT.TEXT_INPUT
    : isIncludeTargetsStep || isAdvancedConfigStep
      ? 'Space toggle · Enter confirm · Esc back'
      : isConfirmStep
        ? HELP_TEXT.CONFIRM_CANCEL
        : isAuthorizerStep || isPolicyEngineStep
          ? HELP_TEXT.NAVIGATE_SELECT
          : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={GATEWAY_STEP_LABELS} />;

  return (
    <Screen title="Add Gateway" onExit={onExit} helpText={helpText} headerContent={headerContent} exitEnabled={false}>
      <Panel>
        {isNameStep && (
          <TextInput
            key={wizard.step}
            prompt={GATEWAY_STEP_LABELS[wizard.step]}
            initialValue={generateUniqueName('my-gateway', existingGateways, { separator: '-' })}
            onSubmit={wizard.setName}
            onCancel={onExit}
            schema={GatewayNameSchema}
            customValidation={value => !existingGateways.includes(value) || 'Gateway name already exists'}
          />
        )}

        {isAuthorizerStep && (
          <Box flexDirection="column">
            <WizardSelect
              title="Select authorizer type"
              description="How will clients authenticate to this gateway?"
              items={authorizerItems}
              selectedIndex={authorizerNav.selectedIndex}
            />
            {authorizerItems[authorizerNav.selectedIndex]?.id === 'NONE' && (
              <Box marginTop={1}>
                <Text color="yellow">⚠️ Warning: Gateway will be publicly accessible without authorization</Text>
              </Box>
            )}
          </Box>
        )}

        {isJwtConfigStep && (
          <JwtConfigInput
            subStep={jwtFlow.subStep}
            steps={jwtFlow.steps}
            selectedConstraints={jwtFlow.selectedConstraints}
            customClaims={jwtFlow.customClaims}
            discoveryUrl={jwtFlow.discoveryUrl}
            audience={jwtFlow.audience}
            clients={jwtFlow.clients}
            scopes={jwtFlow.scopes}
            onDiscoveryUrl={jwtFlow.handlers.handleDiscoveryUrl}
            onConstraintsPicked={jwtFlow.handlers.handleConstraintsPicked}
            onAudience={jwtFlow.handlers.handleAudience}
            onClients={jwtFlow.handlers.handleClients}
            onScopes={jwtFlow.handlers.handleScopes}
            onCustomClaimsDone={jwtFlow.handlers.handleCustomClaimsDone}
            onClientId={jwtFlow.handlers.handleClientId}
            onClientIdSkip={jwtFlow.handlers.handleClientIdSkip}
            onClientSecret={jwtFlow.handlers.handleClientSecret}
            onBack={jwtFlow.goBack}
            onClaimsManagerModeChange={jwtFlow.handlers.handleClaimsManagerModeChange}
          />
        )}

        {isIncludeTargetsStep &&
          (unassignedTargetItems.length > 0 ? (
            <WizardMultiSelect
              title="Select unassigned targets to include in this gateway"
              items={unassignedTargetItems}
              cursorIndex={targetsNav.cursorIndex}
              selectedIds={targetsNav.selectedIds}
            />
          ) : (
            <Text dimColor>No unassigned targets available. Press Enter to continue.</Text>
          ))}

        {isPolicyEngineStep && policyEngineSubStep === 0 && (
          <WizardSelect
            title="Select a policy engine"
            description="Attach a Cedar policy engine to authorize tool calls on this gateway"
            items={policyEngineItems}
            selectedIndex={policyEngineNav.selectedIndex}
          />
        )}

        {isPolicyEngineStep && policyEngineSubStep === 1 && (
          <WizardSelect
            title="Select enforcement mode"
            description={`Policy engine: ${selectedEngineName}`}
            items={policyEngineModeItems}
            selectedIndex={policyEngineModeNav.selectedIndex}
          />
        )}

        {isAdvancedConfigStep && (
          <Box flexDirection="column">
            <Text bold>Advanced Configuration</Text>
            <Text dimColor>Toggle options with Space, press Enter to continue</Text>
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
          </Box>
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Name', value: wizard.config.name },
              { label: 'Description', value: wizard.config.description },
              {
                label: 'Authorizer',
                value:
                  AUTHORIZER_TYPE_OPTIONS.find(o => o.id === wizard.config.authorizerType)?.title ??
                  wizard.config.authorizerType,
              },
              ...(wizard.config.authorizerType === 'CUSTOM_JWT' && wizard.config.jwtConfig
                ? [
                    { label: 'Discovery URL', value: wizard.config.jwtConfig.discoveryUrl },
                    ...(wizard.config.jwtConfig.allowedAudience?.length
                      ? [{ label: 'Allowed Audience', value: wizard.config.jwtConfig.allowedAudience.join(', ') }]
                      : []),
                    ...(wizard.config.jwtConfig.allowedClients?.length
                      ? [{ label: 'Allowed Clients', value: wizard.config.jwtConfig.allowedClients.join(', ') }]
                      : []),
                    ...(wizard.config.jwtConfig.allowedScopes?.length
                      ? [{ label: 'Allowed Scopes', value: wizard.config.jwtConfig.allowedScopes.join(', ') }]
                      : []),
                    ...(wizard.config.jwtConfig.customClaims?.length
                      ? [
                          {
                            label: 'Custom Claims',
                            value: `${wizard.config.jwtConfig.customClaims.length} claim(s) configured`,
                          },
                        ]
                      : []),
                    ...(wizard.config.jwtConfig.clientId
                      ? [{ label: 'Gateway Credential', value: computeManagedOAuthCredentialName(wizard.config.name) }]
                      : []),
                  ]
                : []),
              {
                label: 'Targets',
                value:
                  wizard.config.selectedTargets && wizard.config.selectedTargets.length > 0
                    ? wizard.config.selectedTargets.join(', ')
                    : '(none)',
              },
              { label: 'Semantic Search', value: wizard.config.enableSemanticSearch ? 'Enabled' : 'Disabled' },
              { label: 'Exception Level', value: wizard.config.exceptionLevel === 'DEBUG' ? 'Debug' : 'None' },
              ...(wizard.config.policyEngineConfiguration
                ? [
                    { label: 'Policy Engine', value: wizard.config.policyEngineConfiguration.policyEngineName },
                    { label: 'Enforcement Mode', value: wizard.config.policyEngineConfiguration.mode },
                  ]
                : []),
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}
