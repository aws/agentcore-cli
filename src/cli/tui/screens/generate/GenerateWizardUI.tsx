import type { ModelProvider, NetworkMode, RuntimeAuthorizerType } from '../../../../schema';
import { DEFAULT_MODEL_IDS, ProjectNameSchema } from '../../../../schema';
import { parseAndNormalizeHeaders, validateHeaderAllowlist } from '../../../commands/shared/header-utils';
import { validateSecurityGroupIds, validateSubnetIds } from '../../../commands/shared/vpc-utils';
import { computeDefaultCredentialEnvVarName } from '../../../primitives/credential-utils';
import { ApiKeySecretInput, Panel, SelectList, StepIndicator, TextInput } from '../../components';
import type { SelectableItem } from '../../components';
import { JwtConfigInput, useJwtConfigFlow } from '../../components/jwt-config';
import { useListNavigation } from '../../hooks';
import { RUNTIME_AUTHORIZER_TYPE_OPTIONS } from '../agent/types';
import type { BuildType, GenerateConfig, GenerateStep, MemoryOption, ProtocolMode } from './types';
import {
  ADVANCED_OPTIONS,
  BUILD_TYPE_OPTIONS,
  LANGUAGE_OPTIONS,
  MEMORY_OPTIONS,
  NETWORK_MODE_OPTIONS,
  PROTOCOL_OPTIONS,
  STEP_LABELS,
  getModelProviderOptionsForSdk,
  getSDKOptionsForProtocol,
} from './types';
import type { useGenerateWizard } from './useGenerateWizard';
import { Box, Text, useInput } from 'ink';

// Helper to get provider display name and env var name from ModelProvider
function getProviderInfo(provider: ModelProvider): { name: string; envVarName: string } {
  switch (provider) {
    case 'OpenAI':
      return { name: 'OpenAI', envVarName: 'OPENAI_API_KEY' };
    case 'Anthropic':
      return { name: 'Anthropic', envVarName: 'ANTHROPIC_API_KEY' };
    case 'Gemini':
      return { name: 'Google Gemini', envVarName: 'GEMINI_API_KEY' };
    case 'Bedrock':
      return { name: 'Amazon Bedrock', envVarName: '' };
  }
}

interface GenerateWizardUIProps {
  wizard: ReturnType<typeof useGenerateWizard>;
  onBack: () => void;
  onConfirm: () => void;
  isActive: boolean;
  credentialProjectName?: string; // Override for credential naming (add agent flow)
}

/**
 * Reusable wizard UI component for agent generation.
 * Used by the create command flow (embedded in create flow).
 */
export function GenerateWizardUI({
  wizard,
  onBack,
  onConfirm,
  isActive,
  credentialProjectName,
}: GenerateWizardUIProps) {
  const getItems = (): SelectableItem[] => {
    switch (wizard.step) {
      case 'language':
        return LANGUAGE_OPTIONS.map(o => ({
          id: o.id,
          title: o.title,
          disabled: 'disabled' in o ? o.disabled : undefined,
        }));
      case 'buildType':
        return BUILD_TYPE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description }));
      case 'protocol':
        return PROTOCOL_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description }));
      case 'sdk':
        return getSDKOptionsForProtocol(wizard.config.protocol).map(o => ({
          id: o.id,
          title: o.title,
          description: o.description,
        }));
      case 'modelProvider':
        // Filter model providers based on selected SDK
        return getModelProviderOptionsForSdk(wizard.config.sdk).map(o => ({
          id: o.id,
          title: o.title,
          description: o.description,
        }));
      case 'memory':
        return MEMORY_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description }));
      case 'advanced':
        return ADVANCED_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description }));
      case 'networkMode':
        return NETWORK_MODE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description }));
      case 'authorizerType':
        return RUNTIME_AUTHORIZER_TYPE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description }));
      default:
        return [];
    }
  };

  const items = getItems();
  const isSelectStep = items.length > 0;
  const isTextStep = wizard.step === 'projectName';
  const isApiKeyStep = wizard.step === 'apiKey';
  const isSubnetsStep = wizard.step === 'subnets';
  const isSecurityGroupsStep = wizard.step === 'securityGroups';
  const isRequestHeaderAllowlistStep = wizard.step === 'requestHeaderAllowlist';
  const isJwtConfigStep = wizard.step === 'jwtConfig';
  const isConfirmStep = wizard.step === 'confirm';

  const handleSelect = (item: SelectableItem) => {
    switch (wizard.step) {
      case 'language':
        wizard.setLanguage(item.id as GenerateConfig['language']);
        break;
      case 'buildType':
        wizard.setBuildType(item.id as BuildType);
        break;
      case 'protocol':
        wizard.setProtocol(item.id as ProtocolMode);
        break;
      case 'sdk':
        wizard.setSdk(item.id as GenerateConfig['sdk']);
        break;
      case 'modelProvider':
        wizard.setModelProvider(item.id as GenerateConfig['modelProvider']);
        break;
      case 'memory':
        wizard.setMemory(item.id as MemoryOption);
        break;
      case 'advanced':
        wizard.setAdvanced(item.id === 'yes');
        break;
      case 'networkMode':
        wizard.setNetworkMode(item.id as NetworkMode);
        break;
      case 'authorizerType':
        wizard.setAuthorizerType(item.id as RuntimeAuthorizerType);
        break;
    }
  };

  const { selectedIndex } = useListNavigation({
    items,
    onSelect: handleSelect,
    onExit: onBack,
    isActive: isActive && isSelectStep,
    isDisabled: item => item.disabled ?? false,
    resetKey: wizard.step,
  });

  // JWT config flow for CUSTOM_JWT authorizer
  const jwtFlow = useJwtConfigFlow({
    onComplete: jwtConfig => {
      wizard.setJwtConfig(jwtConfig);
    },
    onBack: () => {
      wizard.goBack();
    },
  });

  // Handle confirm step input
  useInput(
    (input, key) => {
      if (key.return || input === 'y') {
        onConfirm();
      } else if (key.escape) {
        onBack();
      }
    },
    { isActive: isActive && isConfirmStep }
  );

  return (
    <Panel>
      {isTextStep && (
        <Box flexDirection="column">
          <TextInput
            prompt="What should the agent be called?"
            initialValue={wizard.config.projectName}
            schema={ProjectNameSchema}
            onSubmit={wizard.setProjectName}
            onCancel={onBack}
          />
          {wizard.error && (
            <Box marginTop={1}>
              <Text color="red">✗ {wizard.error}</Text>
            </Box>
          )}
        </Box>
      )}

      {isSelectStep && <SelectList items={items} selectedIndex={selectedIndex} />}

      {isApiKeyStep && (
        <ApiKeySecretInput
          providerName={getProviderInfo(wizard.config.modelProvider).name}
          envVarName={getProviderInfo(wizard.config.modelProvider).envVarName}
          onSubmit={wizard.setApiKey}
          onSkip={wizard.skipApiKey}
          onCancel={onBack}
          isActive={isActive}
        />
      )}

      {isSubnetsStep && (
        <TextInput
          prompt="Subnet IDs (comma-separated)"
          initialValue={(wizard.config.subnets ?? []).join(', ')}
          customValidation={validateSubnetIds}
          onSubmit={value => {
            wizard.setSubnets(
              value
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
            );
          }}
          onCancel={onBack}
        />
      )}

      {isSecurityGroupsStep && (
        <TextInput
          prompt="Security group IDs (comma-separated)"
          initialValue={(wizard.config.securityGroups ?? []).join(', ')}
          customValidation={validateSecurityGroupIds}
          onSubmit={value => {
            wizard.setSecurityGroups(
              value
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
            );
          }}
          onCancel={onBack}
        />
      )}

      {isRequestHeaderAllowlistStep && (
        <Box flexDirection="column">
          <TextInput
            prompt="Allowed request headers (comma-separated, or press Enter to skip)"
            initialValue={(wizard.config.requestHeaderAllowlist ?? []).join(', ')}
            customValidation={value => {
              const result = validateHeaderAllowlist(value);
              return result.success ? true : result.error!;
            }}
            onSubmit={value => {
              const headers = parseAndNormalizeHeaders(value);
              if (headers.length > 0) {
                wizard.setRequestHeaderAllowlist(headers);
              } else {
                wizard.skipRequestHeaderAllowlist();
              }
            }}
            onCancel={onBack}
          />
          <Box marginTop={1}>
            <Text dimColor>
              Enter header suffixes or full names. We auto-prefix with X-Amzn-Bedrock-AgentCore-Runtime-Custom- if
              needed. &apos;Authorization&apos; is also accepted.
            </Text>
          </Box>
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

      {isConfirmStep && <ConfirmView config={wizard.config} credentialProjectName={credentialProjectName} />}
    </Panel>
  );
}

/**
 * Returns the appropriate help text for the current wizard step.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function getWizardHelpText(step: GenerateStep): string {
  if (step === 'confirm') return 'Enter/Y confirm · Esc back';
  if (step === 'projectName' || step === 'subnets' || step === 'securityGroups' || step === 'requestHeaderAllowlist')
    return 'Enter submit · Esc cancel';
  if (step === 'apiKey') return 'Enter submit · Tab show/hide · Esc back';
  if (step === 'jwtConfig') return 'Enter submit · Esc back';
  return '↑↓ navigate · Enter select · Esc back';
}

/**
 * Renders the step indicator for the wizard.
 */
export function GenerateWizardStepIndicator({ wizard }: { wizard: ReturnType<typeof useGenerateWizard> }) {
  return <StepIndicator<GenerateStep> steps={wizard.steps} currentStep={wizard.step} labels={STEP_LABELS} />;
}

function getMemoryLabel(memory: MemoryOption): string {
  switch (memory) {
    case 'none':
      return 'None';
    case 'shortTerm':
      return 'Short-term';
    case 'longAndShortTerm':
      return 'Long-term + short-term';
  }
}

function ConfirmView({ config, credentialProjectName }: { config: GenerateConfig; credentialProjectName?: string }) {
  const languageLabel = LANGUAGE_OPTIONS.find(o => o.id === config.language)?.title ?? config.language;
  const buildTypeLabel = BUILD_TYPE_OPTIONS.find(o => o.id === config.buildType)?.title ?? config.buildType;
  const protocolLabel = PROTOCOL_OPTIONS.find(o => o.id === config.protocol)?.title ?? config.protocol;
  const memoryLabel = getMemoryLabel(config.memory);
  const isMcp = config.protocol === 'MCP';

  // Use credentialProjectName if provided, otherwise use config.projectName
  const projectNameForCredential = credentialProjectName ?? config.projectName;
  const credentialName = `${projectNameForCredential}${config.modelProvider}`;
  const envVarName = computeDefaultCredentialEnvVarName(credentialName);

  return (
    <Box flexDirection="column">
      <Text bold>Review Configuration</Text>
      <Box flexDirection="column" marginTop={1} marginLeft={2}>
        <Text>
          <Text dimColor>Name: </Text>
          <Text>{config.projectName}</Text>
        </Text>
        <Text>
          <Text dimColor>Language: </Text>
          <Text>{languageLabel}</Text>
        </Text>
        <Text>
          <Text dimColor>Build: </Text>
          <Text>{buildTypeLabel}</Text>
        </Text>
        <Text>
          <Text dimColor>Protocol: </Text>
          <Text>{protocolLabel}</Text>
        </Text>
        {!isMcp && (
          <>
            <Text>
              <Text dimColor>Framework: </Text>
              <Text>{config.sdk}</Text>
            </Text>
            <Text>
              <Text dimColor>Model Provider: </Text>
              <Text>
                {config.modelProvider} ({DEFAULT_MODEL_IDS[config.modelProvider]})
              </Text>
            </Text>
            {config.modelProvider !== 'Bedrock' && (
              <Text>
                <Text dimColor>API Key: </Text>
                <Text color={config.apiKey ? 'green' : 'yellow'}>
                  {config.apiKey ? 'Configured' : `Not set - fill in ${envVarName} in .env.local`}
                </Text>
              </Text>
            )}
            <Text>
              <Text dimColor>Memory: </Text>
              <Text>{memoryLabel}</Text>
            </Text>
          </>
        )}
        <Text>
          <Text dimColor>Network: </Text>
          <Text>{config.networkMode ?? 'PUBLIC'}</Text>
        </Text>
        {config.networkMode === 'VPC' && config.subnets && (
          <Text>
            <Text dimColor>Subnets: </Text>
            <Text>{config.subnets.join(', ')}</Text>
          </Text>
        )}
        {config.networkMode === 'VPC' && config.securityGroups && (
          <Text>
            <Text dimColor>Security Groups: </Text>
            <Text>{config.securityGroups.join(', ')}</Text>
          </Text>
        )}
        {config.requestHeaderAllowlist && config.requestHeaderAllowlist.length > 0 && (
          <Text>
            <Text dimColor>Headers: </Text>
            <Text>{config.requestHeaderAllowlist.join(', ')}</Text>
          </Text>
        )}
        {config.authorizerType && config.authorizerType !== 'AWS_IAM' && (
          <Text>
            <Text dimColor>Inbound Auth: </Text>
            <Text>
              {RUNTIME_AUTHORIZER_TYPE_OPTIONS.find(o => o.id === config.authorizerType)?.title ??
                config.authorizerType}
            </Text>
          </Text>
        )}
        {config.authorizerType === 'CUSTOM_JWT' && config.jwtConfig && (
          <>
            <Text>
              <Text dimColor>Discovery URL: </Text>
              <Text>{config.jwtConfig.discoveryUrl}</Text>
            </Text>
            {config.jwtConfig.allowedAudience && config.jwtConfig.allowedAudience.length > 0 && (
              <Text>
                <Text dimColor>Allowed Audience: </Text>
                <Text>{config.jwtConfig.allowedAudience.join(', ')}</Text>
              </Text>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
