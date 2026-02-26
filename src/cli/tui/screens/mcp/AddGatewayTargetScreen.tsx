import { ToolNameSchema } from '../../../../schema';
import { ConfirmReview, Panel, Screen, SecretInput, StepIndicator, TextInput, WizardSelect } from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import { useCreateIdentity, useExistingCredentialNames } from '../identity/useCreateIdentity.js';
import type { AddGatewayTargetConfig } from './types';
import { MCP_TOOL_STEP_LABELS, OUTBOUND_AUTH_OPTIONS, SKIP_FOR_NOW } from './types';
import { useAddGatewayTargetWizard } from './useAddGatewayTargetWizard';
import { Box, Text } from 'ink';
import React, { useMemo, useState } from 'react';

interface AddGatewayTargetScreenProps {
  existingGateways: string[];
  existingToolNames: string[];
  onComplete: (config: AddGatewayTargetConfig) => void;
  onExit: () => void;
}

export function AddGatewayTargetScreen({
  existingGateways,
  existingToolNames,
  onComplete,
  onExit,
}: AddGatewayTargetScreenProps) {
  const wizard = useAddGatewayTargetWizard(existingGateways);
  const { names: existingCredentialNames } = useExistingCredentialNames();
  const { createIdentity } = useCreateIdentity();

  // Outbound auth sub-step state
  const [outboundAuthType, setOutboundAuthTypeLocal] = useState<string | null>(null);
  const [credentialName, setCredentialNameLocal] = useState<string | null>(null);
  const [isCreatingCredential, setIsCreatingCredential] = useState(false);
  const [oauthSubStep, setOauthSubStep] = useState<'name' | 'client-id' | 'client-secret' | 'discovery-url'>('name');
  const [oauthFields, setOauthFields] = useState({ name: '', clientId: '', clientSecret: '', discoveryUrl: '' });
  const [apiKeySubStep, setApiKeySubStep] = useState<'name' | 'api-key'>('name');
  const [apiKeyFields, setApiKeyFields] = useState({ name: '', apiKey: '' });

  const gatewayItems: SelectableItem[] = useMemo(
    () => [
      ...existingGateways.map(g => ({ id: g, title: g })),
      { id: SKIP_FOR_NOW, title: 'Skip for now', description: 'Create unassigned target' },
    ],
    [existingGateways]
  );

  const outboundAuthItems: SelectableItem[] = useMemo(
    () => OUTBOUND_AUTH_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const credentialItems: SelectableItem[] = useMemo(() => {
    const items: SelectableItem[] = [
      { id: 'create-new', title: 'Create new credential', description: 'Create a new credential inline' },
    ];
    existingCredentialNames.forEach(name => {
      items.push({ id: name, title: name, description: 'Use existing credential' });
    });
    return items;
  }, [existingCredentialNames]);

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
      const authType = item.id as 'OAUTH' | 'API_KEY' | 'NONE';
      setOutboundAuthTypeLocal(authType);
      if (authType === 'NONE') {
        wizard.setOutboundAuth({ type: 'NONE' });
      }
    },
    onExit: () => wizard.goBack(),
    isActive: isOutboundAuthStep && !outboundAuthType,
  });

  const credentialNav = useListNavigation({
    items: credentialItems,
    onSelect: item => {
      if (item.id === 'create-new') {
        setIsCreatingCredential(true);
        if (outboundAuthType === 'OAUTH') {
          setOauthSubStep('name');
        } else {
          setApiKeySubStep('name');
        }
      } else {
        setCredentialNameLocal(item.id);
        wizard.setOutboundAuth({ type: outboundAuthType as 'OAUTH' | 'API_KEY', credentialName: item.id });
      }
    },
    onExit: () => {
      setOutboundAuthTypeLocal(null);
      setCredentialNameLocal(null);
      setIsCreatingCredential(false);
    },
    isActive:
      isOutboundAuthStep &&
      !!outboundAuthType &&
      outboundAuthType !== 'NONE' &&
      !credentialName &&
      !isCreatingCredential,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => {
      setOutboundAuthTypeLocal(null);
      setCredentialNameLocal(null);
      setIsCreatingCredential(false);
      setOauthSubStep('name');
      setOauthFields({ name: '', clientId: '', clientSecret: '', discoveryUrl: '' });
      setApiKeySubStep('name');
      setApiKeyFields({ name: '', apiKey: '' });
      wizard.goBack();
    },
    isActive: isConfirmStep,
  });

  // OAuth creation handlers
  const handleOauthFieldSubmit = (value: string) => {
    const newFields = { ...oauthFields };

    if (oauthSubStep === 'name') {
      newFields.name = value;
      setOauthFields(newFields);
      setOauthSubStep('client-id');
    } else if (oauthSubStep === 'client-id') {
      newFields.clientId = value;
      setOauthFields(newFields);
      setOauthSubStep('client-secret');
    } else if (oauthSubStep === 'client-secret') {
      newFields.clientSecret = value;
      setOauthFields(newFields);
      setOauthSubStep('discovery-url');
    } else if (oauthSubStep === 'discovery-url') {
      newFields.discoveryUrl = value;
      setOauthFields(newFields);

      // Create the credential
      void createIdentity({
        type: 'OAuthCredentialProvider',
        name: newFields.name,
        clientId: newFields.clientId,
        clientSecret: newFields.clientSecret,
        discoveryUrl: newFields.discoveryUrl,
      })
        .then(result => {
          if (result.ok) {
            wizard.setOutboundAuth({ type: 'OAUTH', credentialName: newFields.name });
          } else {
            setIsCreatingCredential(false);
            setOauthSubStep('name');
            setOauthFields({ name: '', clientId: '', clientSecret: '', discoveryUrl: '' });
          }
        })
        .catch(() => {
          setIsCreatingCredential(false);
          setOauthSubStep('name');
          setOauthFields({ name: '', clientId: '', clientSecret: '', discoveryUrl: '' });
        });
    }
  };

  const handleOauthFieldCancel = () => {
    if (oauthSubStep === 'name') {
      setIsCreatingCredential(false);
      setOauthFields({ name: '', clientId: '', clientSecret: '', discoveryUrl: '' });
    } else if (oauthSubStep === 'client-id') {
      setOauthSubStep('name');
    } else if (oauthSubStep === 'client-secret') {
      setOauthSubStep('client-id');
    } else if (oauthSubStep === 'discovery-url') {
      setOauthSubStep('client-secret');
    }
  };

  // API Key creation handlers
  const handleApiKeyFieldSubmit = (value: string) => {
    const newFields = { ...apiKeyFields };

    if (apiKeySubStep === 'name') {
      newFields.name = value;
      setApiKeyFields(newFields);
      setApiKeySubStep('api-key');
    } else if (apiKeySubStep === 'api-key') {
      newFields.apiKey = value;
      setApiKeyFields(newFields);

      void createIdentity({
        type: 'ApiKeyCredentialProvider',
        name: newFields.name,
        apiKey: newFields.apiKey,
      })
        .then(result => {
          if (result.ok) {
            wizard.setOutboundAuth({ type: 'API_KEY', credentialName: newFields.name });
          } else {
            setIsCreatingCredential(false);
            setApiKeySubStep('name');
            setApiKeyFields({ name: '', apiKey: '' });
          }
        })
        .catch(() => {
          setIsCreatingCredential(false);
          setApiKeySubStep('name');
          setApiKeyFields({ name: '', apiKey: '' });
        });
    }
  };

  const handleApiKeyFieldCancel = () => {
    if (apiKeySubStep === 'name') {
      setIsCreatingCredential(false);
      setApiKeyFields({ name: '', apiKey: '' });
    } else if (apiKeySubStep === 'api-key') {
      setApiKeySubStep('name');
    }
  };

  const helpText = isConfirmStep
    ? HELP_TEXT.CONFIRM_CANCEL
    : isTextStep || isCreatingCredential
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

        {isOutboundAuthStep &&
          outboundAuthType &&
          outboundAuthType !== 'NONE' &&
          !credentialName &&
          !isCreatingCredential && (
            <WizardSelect
              title="Select credential"
              description={`Choose a credential for ${outboundAuthType} authentication`}
              items={credentialItems}
              selectedIndex={credentialNav.selectedIndex}
            />
          )}

        {isOutboundAuthStep && isCreatingCredential && outboundAuthType === 'OAUTH' && (
          <>
            {oauthSubStep === 'name' && (
              <TextInput
                key="oauth-name"
                prompt="Credential name"
                initialValue={generateUniqueName('MyOAuth', existingCredentialNames)}
                onSubmit={handleOauthFieldSubmit}
                onCancel={handleOauthFieldCancel}
                customValidation={value => !existingCredentialNames.includes(value) || 'Credential name already exists'}
              />
            )}
            {oauthSubStep === 'client-id' && (
              <TextInput
                key="oauth-client-id"
                prompt="Client ID"
                onSubmit={handleOauthFieldSubmit}
                onCancel={handleOauthFieldCancel}
                customValidation={value => value.trim().length > 0 || 'Client ID is required'}
              />
            )}
            {oauthSubStep === 'client-secret' && (
              <SecretInput
                key="oauth-client-secret"
                prompt="Client Secret"
                onSubmit={handleOauthFieldSubmit}
                onCancel={handleOauthFieldCancel}
                customValidation={value => value.trim().length > 0 || 'Client secret is required'}
                revealChars={4}
              />
            )}
            {oauthSubStep === 'discovery-url' && (
              <TextInput
                key="oauth-discovery-url"
                prompt="Discovery URL"
                placeholder="https://example.com/.well-known/openid_configuration"
                onSubmit={handleOauthFieldSubmit}
                onCancel={handleOauthFieldCancel}
                customValidation={value => {
                  try {
                    const url = new URL(value);
                    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                      return 'Discovery URL must use http:// or https:// protocol';
                    }
                    return true;
                  } catch {
                    return 'Must be a valid URL';
                  }
                }}
              />
            )}
          </>
        )}

        {isOutboundAuthStep && isCreatingCredential && outboundAuthType === 'API_KEY' && (
          <>
            {apiKeySubStep === 'name' && (
              <TextInput
                key="apikey-name"
                prompt="Credential name"
                initialValue={generateUniqueName('MyApiKey', existingCredentialNames)}
                onSubmit={handleApiKeyFieldSubmit}
                onCancel={handleApiKeyFieldCancel}
                customValidation={value => !existingCredentialNames.includes(value) || 'Credential name already exists'}
              />
            )}
            {apiKeySubStep === 'api-key' && (
              <SecretInput
                key="apikey-value"
                prompt="API Key"
                onSubmit={handleApiKeyFieldSubmit}
                onCancel={handleApiKeyFieldCancel}
                customValidation={value => value.trim().length > 0 || 'API key is required'}
                revealChars={4}
              />
            )}
          </>
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
              ...(wizard.config.gateway ? [{ label: 'Gateway', value: wizard.config.gateway }] : []),
              ...(!wizard.config.gateway ? [{ label: 'Gateway', value: '(none - assign later)' }] : []),
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
