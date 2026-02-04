import type { GatewayAuthorizerType } from '../../../../schema';
import { GatewayNameSchema } from '../../../../schema';
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
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddGatewayConfig } from './types';
import { AUTHORIZER_TYPE_OPTIONS, GATEWAY_STEP_LABELS } from './types';
import { useAddGatewayWizard } from './useAddGatewayWizard';
import { Box, Text } from 'ink';
import React, { useMemo, useState } from 'react';

interface AddGatewayScreenProps {
  onComplete: (config: AddGatewayConfig) => void;
  onExit: () => void;
  existingGateways: string[];
  availableAgents: string[];
}

export function AddGatewayScreen({ onComplete, onExit, existingGateways, availableAgents }: AddGatewayScreenProps) {
  const wizard = useAddGatewayWizard();

  // JWT config sub-step tracking (0 = discoveryUrl, 1 = audience, 2 = clients)
  const [jwtSubStep, setJwtSubStep] = useState(0);
  const [jwtDiscoveryUrl, setJwtDiscoveryUrl] = useState('');
  const [jwtAudience, setJwtAudience] = useState('');

  const agentItems: SelectableItem[] = useMemo(
    () => availableAgents.map(name => ({ id: name, title: name })),
    [availableAgents]
  );

  const authorizerItems: SelectableItem[] = useMemo(
    () => AUTHORIZER_TYPE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const isNameStep = wizard.step === 'name';
  const isAuthorizerStep = wizard.step === 'authorizer';
  const isJwtConfigStep = wizard.step === 'jwt-config';
  const isAgentsStep = wizard.step === 'agents';
  const isConfirmStep = wizard.step === 'confirm';

  const authorizerNav = useListNavigation({
    items: authorizerItems,
    onSelect: item => wizard.setAuthorizerType(item.id as GatewayAuthorizerType),
    onExit: () => wizard.goBack(),
    isActive: isAuthorizerStep,
  });

  const agentsNav = useMultiSelectNavigation({
    items: agentItems,
    getId: item => item.id,
    onConfirm: ids => wizard.setAgents(ids),
    onExit: () => wizard.goBack(),
    isActive: isAgentsStep,
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
    // Parse comma-separated values
    const audienceList = jwtAudience
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const clientsList = clients
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    wizard.setJwtConfig({
      discoveryUrl: jwtDiscoveryUrl,
      allowedAudience: audienceList,
      allowedClients: clientsList,
    });

    // Reset sub-step counter only - preserve values for potential back navigation
    setJwtSubStep(0);
  };

  const handleJwtCancel = () => {
    if (jwtSubStep === 0) {
      wizard.goBack();
    } else {
      setJwtSubStep(jwtSubStep - 1);
    }
  };

  const helpText = isAgentsStep
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
          <WizardSelect
            title="Select authorizer type"
            description="How will clients authenticate to this gateway?"
            items={authorizerItems}
            selectedIndex={authorizerNav.selectedIndex}
          />
        )}

        {isJwtConfigStep && (
          <JwtConfigInput
            subStep={jwtSubStep}
            onDiscoveryUrl={handleJwtDiscoveryUrl}
            onAudience={handleJwtAudience}
            onClients={handleJwtClients}
            onCancel={handleJwtCancel}
          />
        )}

        {isAgentsStep &&
          (agentItems.length > 0 ? (
            <WizardMultiSelect
              title="Select agents to use this gateway"
              items={agentItems}
              cursorIndex={agentsNav.cursorIndex}
              selectedIds={agentsNav.selectedIds}
            />
          ) : (
            <Text dimColor>
              No agents defined. Add agents first via `agentcore add agent`. Press Enter to continue.
            </Text>
          ))}

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
                  ]
                : []),
              { label: 'Agents', value: wizard.config.agents.length > 0 ? wizard.config.agents.join(', ') : '(none)' },
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

function JwtConfigInput({ subStep, onDiscoveryUrl, onAudience, onClients, onCancel }: JwtConfigInputProps) {
  return (
    <Box flexDirection="column">
      <Text bold>Configure Custom JWT Authorizer</Text>
      <Text dimColor>Step {subStep + 1} of 3</Text>
      <Box marginTop={1}>
        {subStep === 0 && (
          <TextInput
            prompt={`Discovery URL (e.g., https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123${OIDC_WELL_KNOWN_SUFFIX})`}
            initialValue="https://"
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
      </Box>
    </Box>
  );
}
