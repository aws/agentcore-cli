import type { ModelProvider, SDKFramework, TargetLanguage } from '../../../../schema';
import { ProviderNameSchema } from '../../../../schema';
import {
  ApiKeySecretInput,
  ConfirmReview,
  Cursor,
  Panel,
  Screen,
  StepIndicator,
  TextInput,
  WizardSelect,
} from '../../components';
import type { SelectableItem } from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useProject } from '../../hooks';
import { generateUniqueName } from '../../utils';
import { GenerateWizardUI, getWizardHelpText, useGenerateWizard } from '../generate';
import type { AddAgentConfig, AgentType } from './types';
import {
  ADD_AGENT_STEP_LABELS,
  AGENT_TYPE_OPTIONS,
  DEFAULT_ENTRYPOINT,
  DEFAULT_PYTHON_VERSION,
  FRAMEWORK_OPTIONS,
  LANGUAGE_OPTIONS,
  getModelProviderOptionsForSdk,
} from './types';
import { Box, Text, useInput } from 'ink';
import React, { useCallback, useMemo, useState } from 'react';

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

interface AddAgentScreenProps {
  existingAgentNames: string[];
  onComplete: (config: AddAgentConfig) => void;
  onExit: () => void;
}

// Steps for the initial phase (before branching to create or byo)
type InitialStep = 'name' | 'agentType';
// Steps for BYO path only
type ByoStep = 'codeLocation' | 'language' | 'framework' | 'modelProvider' | 'apiKey' | 'confirm';

const INITIAL_STEPS: InitialStep[] = ['name', 'agentType'];
const BYO_STEPS: ByoStep[] = ['codeLocation', 'language', 'framework', 'modelProvider', 'apiKey', 'confirm'];

export function AddAgentScreen({ existingAgentNames, onComplete, onExit }: AddAgentScreenProps) {
  // Phase 1: name + agentType selection
  const [name, setName] = useState('');
  const [agentType, setAgentType] = useState<AgentType | null>(null);
  const [initialStep, setInitialStep] = useState<InitialStep>('name');

  // Phase 2 (create path): delegate to generate wizard
  const generateWizard = useGenerateWizard({ initialName: name });

  // Phase 2 (byo path): BYO-specific state
  const [byoStep, setByoStep] = useState<ByoStep>('codeLocation');
  const [byoConfig, setByoConfig] = useState({
    codeLocation: '',
    entrypoint: DEFAULT_ENTRYPOINT,
    language: 'Python' as TargetLanguage,
    framework: 'Strands' as SDKFramework,
    modelProvider: 'Bedrock' as ModelProvider,
    apiKey: undefined as string | undefined,
  });

  const { project } = useProject();

  // Determine which phase/path we're in
  const isInitialPhase = agentType === null;
  const isCreatePath = agentType === 'create';
  const isByoPath = agentType === 'byo';

  // ─────────────────────────────────────────────────────────────────────────────
  // Initial Phase: name + agentType
  // ─────────────────────────────────────────────────────────────────────────────

  const agentTypeItems: SelectableItem[] = useMemo(
    () => AGENT_TYPE_OPTIONS.map(o => ({ id: o.id, title: o.title })),
    []
  );

  const handleSetName = useCallback((value: string) => {
    setName(value);
    setInitialStep('agentType');
  }, []);

  const handleSetAgentType = useCallback(
    (type: AgentType) => {
      setAgentType(type);
      if (type === 'create') {
        // Initialize generate wizard with the agent name
        generateWizard.initWithName(name);
      } else if (type === 'byo') {
        // Initialize BYO code location with agent name
        setByoConfig(c => ({ ...c, codeLocation: `${name}/` }));
      }
    },
    [name, generateWizard]
  );

  const agentTypeNav = useListNavigation({
    items: agentTypeItems,
    onSelect: item => handleSetAgentType(item.id as AgentType),
    onExit: () => {
      setInitialStep('name');
    },
    isActive: isInitialPhase && initialStep === 'agentType',
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Create Path: delegate to GenerateWizardUI
  // ─────────────────────────────────────────────────────────────────────────────

  const handleGenerateComplete = useCallback(() => {
    // Map GenerateConfig to AddAgentConfig
    const config: AddAgentConfig = {
      name,
      agentType: 'create',
      codeLocation: `${name}/`,
      entrypoint: 'main.py',
      language: generateWizard.config.language,
      framework: generateWizard.config.sdk,
      modelProvider: generateWizard.config.modelProvider,
      apiKey: generateWizard.config.apiKey,
      pythonVersion: DEFAULT_PYTHON_VERSION,
      memory: generateWizard.config.memory,
    };
    onComplete(config);
  }, [name, generateWizard.config, onComplete]);

  const handleGenerateBack = useCallback(() => {
    // If at first step of generate wizard, go back to agentType selection
    if (generateWizard.currentIndex === 0) {
      setAgentType(null);
      setInitialStep('agentType');
    } else {
      generateWizard.goBack();
    }
  }, [generateWizard]);

  // ─────────────────────────────────────────────────────────────────────────────
  // BYO Path
  // ─────────────────────────────────────────────────────────────────────────────

  // BYO steps filtering (remove apiKey for Bedrock)
  const byoSteps = useMemo(() => {
    if (byoConfig.modelProvider === 'Bedrock') {
      return BYO_STEPS.filter(s => s !== 'apiKey');
    }
    return BYO_STEPS;
  }, [byoConfig.modelProvider]);

  const byoCurrentIndex = byoSteps.indexOf(byoStep);

  // BYO language options (include "Other" for BYO path)
  const languageItems: SelectableItem[] = useMemo(() => LANGUAGE_OPTIONS.map(o => ({ id: o.id, title: o.title, disabled: o.disabled })), []);

  const frameworkItems: SelectableItem[] = useMemo(
    () => FRAMEWORK_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const modelProviderItems: SelectableItem[] = useMemo(
    () =>
      getModelProviderOptionsForSdk(byoConfig.framework).map(o => ({
        id: o.id,
        title: o.title,
        description: o.description,
      })),
    [byoConfig.framework]
  );

  const handleByoBack = useCallback(() => {
    if (byoCurrentIndex === 0) {
      // Go back to agentType selection
      setAgentType(null);
      setInitialStep('agentType');
    } else {
      const prevStep = byoSteps[byoCurrentIndex - 1];
      if (prevStep) setByoStep(prevStep);
    }
  }, [byoCurrentIndex, byoSteps]);

  const handleByoComplete = useCallback(() => {
    const config: AddAgentConfig = {
      name,
      agentType: 'byo',
      codeLocation: byoConfig.codeLocation,
      entrypoint: byoConfig.entrypoint,
      language: byoConfig.language,
      framework: byoConfig.framework,
      modelProvider: byoConfig.modelProvider,
      apiKey: byoConfig.apiKey,
      pythonVersion: DEFAULT_PYTHON_VERSION,
      memory: 'none',
    };
    onComplete(config);
  }, [name, byoConfig, onComplete]);

  const languageNav = useListNavigation({
    items: languageItems,
    onSelect: item => {
      setByoConfig(c => ({ ...c, language: item.id as TargetLanguage }));
      setByoStep('framework');
    },
    onExit: handleByoBack,
    isActive: isByoPath && byoStep === 'language',
  });

  const frameworkNav = useListNavigation({
    items: frameworkItems,
    onSelect: item => {
      const newFramework = item.id as SDKFramework;
      // Reset modelProvider if it's not supported by the new framework
      const supportedProviders = getModelProviderOptionsForSdk(newFramework);
      const isCurrentProviderSupported = supportedProviders.some(p => p.id === byoConfig.modelProvider);
      const newModelProvider = isCurrentProviderSupported
        ? byoConfig.modelProvider
        : (supportedProviders[0]?.id ?? 'Bedrock');
      setByoConfig(c => ({ ...c, framework: newFramework, modelProvider: newModelProvider }));
      setByoStep('modelProvider');
    },
    onExit: handleByoBack,
    isActive: isByoPath && byoStep === 'framework',
  });

  const modelProviderNav = useListNavigation({
    items: modelProviderItems,
    onSelect: item => {
      const provider = item.id as ModelProvider;
      setByoConfig(c => ({ ...c, modelProvider: provider }));
      if (provider !== 'Bedrock') {
        setByoStep('apiKey');
      } else {
        setByoStep('confirm');
      }
    },
    onExit: handleByoBack,
    isActive: isByoPath && byoStep === 'modelProvider',
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: handleByoComplete,
    onExit: handleByoBack,
    isActive: isByoPath && byoStep === 'confirm',
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────

  // Determine help text
  const getHelpText = () => {
    if (isInitialPhase) {
      return initialStep === 'name' ? HELP_TEXT.TEXT_INPUT : HELP_TEXT.NAVIGATE_SELECT;
    }
    if (isCreatePath) {
      return getWizardHelpText(generateWizard.step);
    }
    // BYO path
    if (byoStep === 'codeLocation' || byoStep === 'apiKey') {
      return HELP_TEXT.TEXT_INPUT;
    }
    if (byoStep === 'confirm') {
      return HELP_TEXT.CONFIRM_CANCEL;
    }
    return HELP_TEXT.NAVIGATE_SELECT;
  };

  // Build step indicator
  const renderStepIndicator = () => {
    if (isInitialPhase) {
      return <StepIndicator steps={INITIAL_STEPS} currentStep={initialStep} labels={ADD_AGENT_STEP_LABELS} />;
    }
    if (isCreatePath) {
      // Show combined steps: name (done) + agentType (done) + generate steps
      const allSteps = ['name', 'agentType', ...generateWizard.steps];
      const currentStep = generateWizard.step;
      return (
        <StepIndicator
          steps={allSteps}
          currentStep={currentStep}
          labels={{ ...ADD_AGENT_STEP_LABELS, sdk: 'Framework' }}
        />
      );
    }
    // BYO path
    const allSteps = ['name', 'agentType', ...byoSteps] as const;
    return <StepIndicator steps={[...allSteps]} currentStep={byoStep} labels={ADD_AGENT_STEP_LABELS} />;
  };

  // Initial phase: name input
  if (isInitialPhase && initialStep === 'name') {
    return (
      <Screen title="Add Agent" onExit={onExit} helpText={HELP_TEXT.TEXT_INPUT} headerContent={renderStepIndicator()}>
        <Panel>
          <TextInput
            prompt="Agent name"
            initialValue={generateUniqueName('MyAgent', existingAgentNames)}
            onSubmit={handleSetName}
            onCancel={onExit}
            schema={ProviderNameSchema}
            customValidation={value => !existingAgentNames.includes(value) || 'Agent name already exists'}
          />
        </Panel>
      </Screen>
    );
  }

  // Initial phase: agentType selection
  if (isInitialPhase && initialStep === 'agentType') {
    return (
      <Screen
        title="Add Agent"
        onExit={onExit}
        helpText={HELP_TEXT.NAVIGATE_SELECT}
        headerContent={renderStepIndicator()}
      >
        <Panel>
          <WizardSelect title="Select agent type" items={agentTypeItems} selectedIndex={agentTypeNav.selectedIndex} />
        </Panel>
      </Screen>
    );
  }

  // Create path: delegate to GenerateWizardUI
  if (isCreatePath) {
    return (
      <Screen title="Add Agent" onExit={onExit} helpText={getHelpText()} headerContent={renderStepIndicator()}>
        <GenerateWizardUI
          wizard={generateWizard}
          onBack={handleGenerateBack}
          onConfirm={handleGenerateComplete}
          isActive={true}
        />
      </Screen>
    );
  }

  // BYO path
  return (
    <Screen title="Add Agent" onExit={onExit} helpText={getHelpText()} headerContent={renderStepIndicator()}>
      <Panel>
        {byoStep === 'codeLocation' && (
          <CodeLocationInput
            projectRoot={project?.projectRoot ?? process.cwd()}
            initialCodeLocation={byoConfig.codeLocation}
            initialEntrypoint={byoConfig.entrypoint}
            onSubmit={(codeLocation, entrypoint) => {
              setByoConfig(c => ({ ...c, codeLocation, entrypoint }));
              setByoStep('language');
              return true;
            }}
            onCancel={handleByoBack}
          />
        )}

        {byoStep === 'language' && (
          <WizardSelect title="Select language" items={languageItems} selectedIndex={languageNav.selectedIndex} />
        )}

        {byoStep === 'framework' && (
          <WizardSelect title="Select framework" items={frameworkItems} selectedIndex={frameworkNav.selectedIndex} />
        )}

        {byoStep === 'modelProvider' && (
          <WizardSelect
            title="Select model provider"
            items={modelProviderItems}
            selectedIndex={modelProviderNav.selectedIndex}
          />
        )}

        {byoStep === 'apiKey' && (
          <ApiKeySecretInput
            providerName={getProviderInfo(byoConfig.modelProvider).name}
            envVarName={getProviderInfo(byoConfig.modelProvider).envVarName}
            onSubmit={apiKey => {
              setByoConfig(c => ({ ...c, apiKey }));
              setByoStep('confirm');
            }}
            onSkip={() => setByoStep('confirm')}
            onCancel={handleByoBack}
          />
        )}

        {byoStep === 'confirm' && (
          <ConfirmReview
            fields={[
              { label: 'Name', value: name },
              { label: 'Type', value: 'Bring my own code' },
              { label: 'Code Location', value: byoConfig.codeLocation },
              { label: 'Entrypoint', value: byoConfig.entrypoint },
              { label: 'Language', value: byoConfig.language },
              {
                label: 'Framework',
                value: FRAMEWORK_OPTIONS.find(o => o.id === byoConfig.framework)?.title ?? byoConfig.framework,
              },
              { label: 'Model Provider', value: byoConfig.modelProvider },
              ...(byoConfig.modelProvider !== 'Bedrock'
                ? [
                    {
                      label: 'API Key',
                      value: byoConfig.apiKey ? (
                        <Text color="green">Configured</Text>
                      ) : (
                        <Text color="yellow">Not set (add to .env later)</Text>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
      </Panel>
    </Screen>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Code Location Input Component (BYO only)
// ─────────────────────────────────────────────────────────────────────────────

interface CodeLocationInputProps {
  projectRoot: string;
  initialCodeLocation: string;
  initialEntrypoint: string;
  onSubmit: (codeLocation: string, entrypoint: string) => boolean;
  onCancel: () => void;
}

type CodeLocationField = 'codeLocation' | 'entrypoint';

function CodeLocationInput({
  projectRoot,
  initialCodeLocation,
  initialEntrypoint,
  onSubmit,
  onCancel,
}: CodeLocationInputProps) {
  const [codeLocation, setCodeLocation] = useState(initialCodeLocation);
  const [entrypoint, setEntrypoint] = useState(initialEntrypoint || DEFAULT_ENTRYPOINT);
  const [activeField, setActiveField] = useState<CodeLocationField>('codeLocation');
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.tab) {
      setActiveField(f => (f === 'codeLocation' ? 'entrypoint' : 'codeLocation'));
      setError(null);
      return;
    }

    if (key.return) {
      if (activeField === 'codeLocation') {
        setActiveField('entrypoint');
        setError(null);
      } else {
        if (!codeLocation.trim() || !entrypoint.trim()) {
          setError('Please fill in both fields');
          return;
        }
        const normalizedCodeLocation = codeLocation.endsWith('/') ? codeLocation : `${codeLocation}/`;
        onSubmit(normalizedCodeLocation, entrypoint);
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (activeField === 'codeLocation') {
        setCodeLocation(v => v.slice(0, -1));
      } else {
        setEntrypoint(v => v.slice(0, -1));
      }
      setError(null);
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      if (activeField === 'codeLocation') {
        setCodeLocation(v => v + input);
      } else {
        setEntrypoint(v => v + input);
      }
      setError(null);
    }
  });

  const displayPath = projectRoot.length > 40 ? '...' + projectRoot.slice(-37) : projectRoot;

  return (
    <Box flexDirection="column">
      <Text bold>Code Location</Text>
      <Box marginTop={1}>
        <Text dimColor>Your agent code must already exist in the project.</Text>
      </Box>
      <Box>
        <Text dimColor>Project: </Text>
        <Text color="blue">{displayPath}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Agent folder (relative to project):</Text>
        <Box>
          <Text color={activeField === 'codeLocation' ? 'cyan' : 'gray'}>&gt; </Text>
          <Text color={activeField === 'codeLocation' ? undefined : 'gray'}>
            {codeLocation || <Text dimColor>my-agent/</Text>}
          </Text>
          {activeField === 'codeLocation' && <Cursor />}
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Entrypoint file (relative to agent folder):</Text>
        <Box>
          <Text color={activeField === 'entrypoint' ? 'cyan' : 'gray'}>&gt; </Text>
          <Text color={activeField === 'entrypoint' ? undefined : 'gray'}>
            {entrypoint || <Text dimColor>main.py</Text>}
          </Text>
          {activeField === 'entrypoint' && <Cursor />}
        </Box>
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Tab switch fields · Enter continue</Text>
        <Text dimColor>No code yet? Go back and select &quot;Create new agent&quot; instead.</Text>
      </Box>
    </Box>
  );
}
