import type { ModelProvider } from '../../../../schema';
import { DEFAULT_MODEL_IDS, ProjectNameSchema } from '../../../../schema';
import { computeDefaultCredentialEnvVarName } from '../../../operations/identity/create-identity';
import { ApiKeySecretInput, Panel, SelectList, StepIndicator, TextInput } from '../../components';
import type { SelectableItem } from '../../components';
import { useListNavigation } from '../../hooks';
import type { GenerateConfig, GenerateStep, MemoryOption } from './types';
import { LANGUAGE_OPTIONS, MEMORY_OPTIONS, SDK_OPTIONS, STEP_LABELS, getModelProviderOptionsForSdk } from './types';
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
      case 'sdk':
        return SDK_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description }));
      case 'modelProvider':
        // Filter model providers based on selected SDK
        return getModelProviderOptionsForSdk(wizard.config.sdk).map(o => ({
          id: o.id,
          title: o.title,
          description: o.description,
        }));
      case 'memory':
        return MEMORY_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description }));
      default:
        return [];
    }
  };

  const items = getItems();
  const isSelectStep = items.length > 0;
  const isTextStep = wizard.step === 'projectName';
  const isApiKeyStep = wizard.step === 'apiKey';
  const isConfirmStep = wizard.step === 'confirm';

  const handleSelect = (item: SelectableItem) => {
    switch (wizard.step) {
      case 'language':
        wizard.setLanguage(item.id as GenerateConfig['language']);
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
  if (step === 'projectName') return 'Enter submit · Esc cancel';
  if (step === 'apiKey') return 'Enter submit · Tab show/hide · Esc back';
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
  const memoryLabel = getMemoryLabel(config.memory);

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
      </Box>
    </Box>
  );
}
