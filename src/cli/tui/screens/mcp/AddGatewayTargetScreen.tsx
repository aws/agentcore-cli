import { ToolNameSchema } from '../../../../schema';
import { ConfirmReview, Panel, Screen, StepIndicator, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddGatewayTargetConfig } from './types';
import { MCP_TOOL_STEP_LABELS, OUTBOUND_AUTH_OPTIONS } from './types';
import { useAddGatewayTargetWizard } from './useAddGatewayTargetWizard';
import { Box, Text } from 'ink';
import React, { useMemo, useState } from 'react';

interface AddGatewayTargetScreenProps {
  existingGateways: string[];
  existingToolNames: string[];
  existingOAuthCredentialNames: string[];
  onComplete: (config: AddGatewayTargetConfig) => void;
  onCreateCredential: (pendingConfig: AddGatewayTargetConfig) => void;
  onExit: () => void;
}

export function AddGatewayTargetScreen({
  existingGateways,
  existingToolNames,
  existingOAuthCredentialNames,
  onComplete,
  onCreateCredential,
  onExit,
}: AddGatewayTargetScreenProps) {
  const wizard = useAddGatewayTargetWizard(existingGateways);

  const [outboundAuthType, setOutboundAuthTypeLocal] = useState<string | null>(null);

  const gatewayItems: SelectableItem[] = useMemo(
    () => existingGateways.map(g => ({ id: g, title: g })),
    [existingGateways]
  );

  const outboundAuthItems: SelectableItem[] = useMemo(
    () => OUTBOUND_AUTH_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const credentialItems: SelectableItem[] = useMemo(() => {
    const items: SelectableItem[] = existingOAuthCredentialNames.map(name => ({
      id: name,
      title: name,
      description: 'Use existing OAuth credential',
    }));
    items.push({ id: 'create-new', title: 'Create new credential', description: 'Create a new OAuth credential' });
    return items;
  }, [existingOAuthCredentialNames]);

  const isGatewayStep = wizard.step === 'gateway';
  const isOutboundAuthStep = wizard.step === 'outbound-auth';
  const isTextStep = wizard.step === 'name' || wizard.step === 'endpoint';
  const isConfirmStep = wizard.step === 'confirm';
  const noGatewaysAvailable = isGatewayStep && existingGateways.length === 0;

  const gatewayNav = useListNavigation({
    items: gatewayItems,
    onSelect: item => wizard.setGateway(item.id),
    onExit: () => wizard.goBack(),
    isActive: isGatewayStep && !noGatewaysAvailable,
  });

  const outboundAuthNav = useListNavigation({
    items: outboundAuthItems,
    onSelect: item => {
      const authType = item.id as 'OAUTH' | 'NONE';
      if (authType === 'NONE') {
        wizard.setOutboundAuth({ type: 'NONE' });
      } else if (existingOAuthCredentialNames.length === 0) {
        // No existing OAuth credentials — go straight to creation
        onCreateCredential(wizard.config);
      } else {
        setOutboundAuthTypeLocal(authType);
      }
    },
    onExit: () => wizard.goBack(),
    isActive: isOutboundAuthStep && !outboundAuthType,
  });

  const credentialNav = useListNavigation({
    items: credentialItems,
    onSelect: item => {
      if (item.id === 'create-new') {
        onCreateCredential(wizard.config);
      } else {
        wizard.setOutboundAuth({ type: 'OAUTH', credentialName: item.id });
      }
    },
    onExit: () => {
      setOutboundAuthTypeLocal(null);
    },
    isActive: isOutboundAuthStep && outboundAuthType === 'OAUTH',
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => {
      setOutboundAuthTypeLocal(null);
      wizard.goBack();
    },
    isActive: isConfirmStep,
  });

  const helpText = isConfirmStep
    ? HELP_TEXT.CONFIRM_CANCEL
    : isTextStep
      ? HELP_TEXT.TEXT_INPUT
      : HELP_TEXT.NAVIGATE_SELECT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={MCP_TOOL_STEP_LABELS} />;

  return (
    <Screen title="Add Gateway Target" onExit={onExit} helpText={helpText} headerContent={headerContent}>
      <Panel>
        {isGatewayStep && !noGatewaysAvailable && (
          <WizardSelect
            title="Select gateway"
            description="Which gateway will route to this tool?"
            items={gatewayItems}
            selectedIndex={gatewayNav.selectedIndex}
          />
        )}

        {noGatewaysAvailable && <NoGatewaysMessage />}

        {isOutboundAuthStep && !outboundAuthType && (
          <WizardSelect
            title="Select outbound authentication"
            description="How will this tool authenticate to external services?"
            items={outboundAuthItems}
            selectedIndex={outboundAuthNav.selectedIndex}
          />
        )}

        {isOutboundAuthStep && outboundAuthType === 'OAUTH' && (
          <WizardSelect
            title="Select credential"
            description="Choose an OAuth credential for authentication"
            items={credentialItems}
            selectedIndex={credentialNav.selectedIndex}
          />
        )}

        {isTextStep && (
          <TextInput
            key={wizard.step}
            prompt={wizard.step === 'endpoint' ? 'MCP server endpoint URL' : MCP_TOOL_STEP_LABELS[wizard.step]}
            initialValue={wizard.step === 'endpoint' ? undefined : generateUniqueName('mytool', existingToolNames)}
            placeholder={wizard.step === 'endpoint' ? 'https://example.com/mcp' : undefined}
            onSubmit={wizard.step === 'endpoint' ? wizard.setEndpoint : wizard.setName}
            onCancel={() => (wizard.currentIndex === 0 ? onExit() : wizard.goBack())}
            schema={wizard.step === 'name' ? ToolNameSchema : undefined}
            customValidation={
              wizard.step === 'name'
                ? value => !existingToolNames.includes(value) || 'Tool name already exists'
                : wizard.step === 'endpoint'
                  ? value => {
                      try {
                        const url = new URL(value);
                        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                          return 'Endpoint must use http:// or https:// protocol';
                        }
                        return true;
                      } catch {
                        return 'Must be a valid URL (e.g. https://example.com/mcp)';
                      }
                    }
                  : undefined
            }
          />
        )}

        {isConfirmStep && (
          <ConfirmReview
            fields={[
              { label: 'Name', value: wizard.config.name },
              ...(wizard.config.endpoint ? [{ label: 'Endpoint', value: wizard.config.endpoint }] : []),
              { label: 'Gateway', value: wizard.config.gateway ?? '' },
              ...(wizard.config.outboundAuth
                ? [
                    { label: 'Auth Type', value: wizard.config.outboundAuth.type },
                    { label: 'Credential', value: wizard.config.outboundAuth.credentialName ?? 'None' },
                  ]
                : []),
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}

function NoGatewaysMessage() {
  return (
    <Box flexDirection="column">
      <Text color="yellow">No gateways found</Text>
      <Text dimColor>Add a gateway first, then attach tools to it.</Text>
      <Box marginTop={1}>
        <Text dimColor>Esc back</Text>
      </Box>
    </Box>
  );
}
