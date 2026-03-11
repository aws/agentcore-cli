import type { GatewayAuthorizerType } from '../../../../schema';
import { GatewayNameSchema } from '../../../../schema';
import {
  ConfirmReview,
  Panel,
  Screen,
  SecretInput,
  StepIndicator,
  TextInput,
  WizardMultiSelect,
  WizardSelect,
} from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddGatewayConfig } from './types';
import { AUTHORIZER_TYPE_OPTIONS, GATEWAY_STEP_LABELS, SEMANTIC_SEARCH_ITEM_ID } from './types';
import { useAddGatewayWizard } from './useAddGatewayWizard';
import { Box, Text } from 'ink';
import React, { useMemo, useState } from 'react';

interface AddGatewayScreenProps {
  onComplete: (config: AddGatewayConfig) => void;
  onExit: () => void;
  existingGateways: string[];
  unassignedTargets: string[];
}

const INITIAL_ADVANCED_SELECTED = [SEMANTIC_SEARCH_ITEM_ID];

export function AddGatewayScreen({ onComplete, onExit, existingGateways, unassignedTargets }: AddGatewayScreenProps) {
  const wizard = useAddGatewayWizard(unassignedTargets.length);

  // JWT config sub-step tracking (0=discoveryUrl, 1=audience, 2=clients, 3=scopes, 4=agentClientId, 5=agentClientSecret)
  const [jwtSubStep, setJwtSubStep] = useState(0);
  const [jwtDiscoveryUrl, setJwtDiscoveryUrl] = useState('');
  const [jwtAudience, setJwtAudience] = useState('');
  const [jwtClients, setJwtClients] = useState('');
  const [jwtScopes, setJwtScopes] = useState('');
  const [jwtAgentClientId, setJwtAgentClientId] = useState('');

  const unassignedTargetItems: SelectableItem[] = useMemo(
    () => unassignedTargets.map(name => ({ id: name, title: name })),
    [unassignedTargets]
  );

  const authorizerItems: SelectableItem[] = useMemo(
    () => AUTHORIZER_TYPE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const advancedConfigItems: SelectableItem[] = useMemo(
    () => [{ id: SEMANTIC_SEARCH_ITEM_ID, title: 'Semantic Search' }],
    []
  );

  const isNameStep = wizard.step === 'name';
  const isAuthorizerStep = wizard.step === 'authorizer';
  const isJwtConfigStep = wizard.step === 'jwt-config';
  const isIncludeTargetsStep = wizard.step === 'include-targets';
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

  const advancedNav = useMultiSelectNavigation({
    items: advancedConfigItems,
    getId: item => item.id,
    initialSelectedIds: INITIAL_ADVANCED_SELECTED,
    onConfirm: selectedIds =>
      wizard.setAdvancedConfig({ enableSemanticSearch: selectedIds.includes(SEMANTIC_SEARCH_ITEM_ID) }),
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

  // JWT config handlers
  const handleJwtDiscoveryUrl = (url: string) => {
    setJwtDiscoveryUrl(url);
    setJwtSubStep(1);
  };

  const handleJwtAudience = (audience: string) => {
    setJwtAudience(audience);
    setJwtSubStep(2);
  };

  const handleJwtClients = (clients: string) => {
    setJwtClients(clients);
    setJwtSubStep(3);
  };

  const handleJwtScopes = (scopes: string) => {
    setJwtScopes(scopes);
    setJwtSubStep(4);
  };

  const handleJwtAgentClientId = (clientId: string) => {
    setJwtAgentClientId(clientId);
    setJwtSubStep(5);
  };

  const handleJwtAgentClientSecret = (clientSecret: string) => {
    const audienceList = jwtAudience
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const clientsList = jwtClients
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const scopesList = jwtScopes
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    wizard.setJwtConfig({
      discoveryUrl: jwtDiscoveryUrl,
      allowedAudience: audienceList,
      allowedClients: clientsList,
      ...(scopesList.length > 0 ? { allowedScopes: scopesList } : {}),
      ...(jwtAgentClientId ? { agentClientId: jwtAgentClientId, agentClientSecret: clientSecret } : {}),
    });

    setJwtSubStep(0);
  };

  const handleJwtCancel = () => {
    if (jwtSubStep === 0) {
      wizard.goBack();
    } else {
      setJwtSubStep(jwtSubStep - 1);
    }
  };

  const helpText =
    isIncludeTargetsStep || isAdvancedConfigStep
      ? 'Space toggle · Enter confirm · Esc back'
      : isConfirmStep
        ? HELP_TEXT.CONFIRM_CANCEL
        : isAuthorizerStep
          ? HELP_TEXT.NAVIGATE_SELECT
          : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={GATEWAY_STEP_LABELS} />;

  return (
    <Screen title="Add Gateway" onExit={onExit} helpText={helpText} headerContent={headerContent}>
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
            subStep={jwtSubStep}
            onDiscoveryUrl={handleJwtDiscoveryUrl}
            onAudience={handleJwtAudience}
            onClients={handleJwtClients}
            onScopes={handleJwtScopes}
            onAgentClientId={handleJwtAgentClientId}
            onAgentClientSecret={handleJwtAgentClientSecret}
            onCancel={handleJwtCancel}
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
              { label: 'Authorizer', value: wizard.config.authorizerType },
              ...(wizard.config.authorizerType === 'CUSTOM_JWT' && wizard.config.jwtConfig
                ? [
                    { label: 'Discovery URL', value: wizard.config.jwtConfig.discoveryUrl },
                    { label: 'Allowed Audience', value: wizard.config.jwtConfig.allowedAudience.join(', ') },
                    { label: 'Allowed Clients', value: wizard.config.jwtConfig.allowedClients.join(', ') },
                    ...(wizard.config.jwtConfig.allowedScopes?.length
                      ? [{ label: 'Allowed Scopes', value: wizard.config.jwtConfig.allowedScopes.join(', ') }]
                      : []),
                    ...(wizard.config.jwtConfig.agentClientId
                      ? [{ label: 'Agent Credential', value: `${wizard.config.name}-agent-oauth` }]
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
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}

interface JwtConfigInputProps {
  subStep: number;
  onDiscoveryUrl: (url: string) => void;
  onAudience: (audience: string) => void;
  onClients: (clients: string) => void;
  onScopes: (scopes: string) => void;
  onAgentClientId: (clientId: string) => void;
  onAgentClientSecret: (clientSecret: string) => void;
  onCancel: () => void;
}

/** OIDC well-known suffix for validation */
const OIDC_WELL_KNOWN_SUFFIX = '/.well-known/openid-configuration';

/** Validates comma-separated list has at least one non-empty value */
function validateCommaSeparatedList(value: string, fieldName: string): true | string {
  const items = value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (items.length === 0) {
    return `At least one ${fieldName} is required`;
  }
  return true;
}

function JwtConfigInput({
  subStep,
  onDiscoveryUrl,
  onAudience,
  onClients,
  onScopes,
  onAgentClientId,
  onAgentClientSecret,
  onCancel,
}: JwtConfigInputProps) {
  const totalSteps = 6;
  return (
    <Box flexDirection="column">
      <Text bold>Configure Custom JWT Authorizer</Text>
      <Text dimColor>
        Step {subStep + 1} of {totalSteps}
      </Text>
      <Box marginTop={1}>
        {subStep === 0 && (
          <TextInput
            prompt="Discovery URL"
            placeholder="https://example.com/.well-known/openid-configuration"
            onSubmit={onDiscoveryUrl}
            onCancel={onCancel}
            customValidation={value => {
              try {
                new URL(value);
              } catch {
                return 'Must be a valid URL';
              }
              if (!value.endsWith(OIDC_WELL_KNOWN_SUFFIX)) {
                return `URL must end with '${OIDC_WELL_KNOWN_SUFFIX}'`;
              }
              return true;
            }}
          />
        )}
        {subStep === 1 && (
          <TextInput
            prompt="Allowed Audience (comma-separated, e.g., 7abc123def456)"
            placeholder="press Enter for none"
            initialValue=""
            onSubmit={onAudience}
            onCancel={onCancel}
            allowEmpty
          />
        )}
        {subStep === 2 && (
          <TextInput
            prompt="Allowed Clients (comma-separated, e.g., 7abc123def456)"
            initialValue=""
            onSubmit={onClients}
            onCancel={onCancel}
            customValidation={value => validateCommaSeparatedList(value, 'client')}
          />
        )}
        {subStep === 3 && (
          <TextInput
            prompt="Allowed Scopes (comma-separated, optional)"
            placeholder="press Enter to skip"
            initialValue=""
            onSubmit={onScopes}
            onCancel={onCancel}
            allowEmpty
          />
        )}
        {subStep === 4 && (
          <SecretInput
            prompt="Agent OAuth Client ID (for Bearer token auth)"
            onSubmit={onAgentClientId}
            onCancel={onCancel}
            revealChars={4}
          />
        )}
        {subStep === 5 && (
          <SecretInput
            prompt="Agent OAuth Client Secret"
            onSubmit={onAgentClientSecret}
            onCancel={onCancel}
            customValidation={value => value.trim().length > 0 || 'Client secret is required'}
            revealChars={4}
          />
        )}
      </Box>
    </Box>
  );
}
