import { ProjectNameSchema } from '../../../../schema';
import type { GenerateConfig, GenerateStep, MemoryOption } from './types';
import { BASE_GENERATE_STEPS, getModelProviderOptionsForSdk } from './types';
import { useCallback, useMemo, useState } from 'react';

function getDefaultConfig(): GenerateConfig {
  return {
    projectName: '',
    sdk: 'Strands',
    modelProvider: 'Bedrock',
    memory: 'none',
    language: 'Python',
  };
}

export interface UseGenerateWizardOptions {
  /** Pre-set the project name and skip the projectName step */
  initialName?: string;
}

export function useGenerateWizard(options?: UseGenerateWizardOptions) {
  const [hasInitialName, setHasInitialName] = useState(Boolean(options?.initialName));
  const initialStep: GenerateStep = hasInitialName ? 'language' : 'projectName';

  const [step, setStep] = useState<GenerateStep>(initialStep);
  const [config, setConfig] = useState<GenerateConfig>(() => ({
    ...getDefaultConfig(),
    ...(options?.initialName ? { projectName: options.initialName } : {}),
  }));
  const [error, setError] = useState<string | null>(null);

  // Steps depend on SDK, model provider, and whether we have an initial name
  // Filter out: projectName if initialName, apiKey for Bedrock, memory for non-Strands SDKs
  const steps = useMemo(() => {
    let filtered = BASE_GENERATE_STEPS;
    if (hasInitialName) {
      filtered = filtered.filter(s => s !== 'projectName');
    }
    if (config.modelProvider === 'Bedrock') {
      filtered = filtered.filter(s => s !== 'apiKey');
    }
    if (config.sdk !== 'Strands') {
      filtered = filtered.filter(s => s !== 'memory');
    }
    return filtered;
  }, [config.modelProvider, config.sdk, hasInitialName]);

  const currentIndex = steps.indexOf(step);

  const setProjectName = useCallback((name: string) => {
    const result = ProjectNameSchema.safeParse(name);
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? 'Invalid agent name');
      return false;
    }
    setError(null);
    setConfig(c => ({ ...c, projectName: name }));
    setStep('language');
    return true;
  }, []);

  const setLanguage = useCallback((language: GenerateConfig['language']) => {
    setConfig(c => ({ ...c, language }));
    setStep('sdk');
  }, []);

  const setSdk = useCallback((sdk: GenerateConfig['sdk']) => {
    setConfig(c => {
      // Reset modelProvider if it's not supported by the new SDK
      const supportedProviders = getModelProviderOptionsForSdk(sdk);
      const isCurrentProviderSupported = supportedProviders.some(p => p.id === c.modelProvider);
      const newModelProvider = isCurrentProviderSupported ? c.modelProvider : (supportedProviders[0]?.id ?? 'Bedrock');
      // Reset memory to 'none' for non-Strands SDKs
      const newMemory = sdk === 'Strands' ? c.memory : 'none';
      return { ...c, sdk, modelProvider: newModelProvider, memory: newMemory };
    });
    setStep('modelProvider');
  }, []);

  const setModelProvider = useCallback(
    (modelProvider: GenerateConfig['modelProvider']) => {
      setConfig(c => ({ ...c, modelProvider }));
      // Non-Bedrock providers need API key step
      if (modelProvider !== 'Bedrock') {
        setStep('apiKey');
      } else if (config.sdk === 'Strands') {
        setStep('memory');
      } else {
        setStep('confirm');
      }
    },
    [config.sdk]
  );

  const setApiKey = useCallback(
    (apiKey: string | undefined) => {
      setConfig(c => ({ ...c, apiKey }));
      if (config.sdk === 'Strands') {
        setStep('memory');
      } else {
        setStep('confirm');
      }
    },
    [config.sdk]
  );

  const skipApiKey = useCallback(() => {
    if (config.sdk === 'Strands') {
      setStep('memory');
    } else {
      setStep('confirm');
    }
  }, [config.sdk]);

  const setMemory = useCallback((memory: MemoryOption) => {
    setConfig(c => ({ ...c, memory }));
    setStep('confirm');
  }, []);

  const goBack = useCallback(() => {
    setError(null);
    const prevStep = steps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex, steps]);

  const reset = useCallback(() => {
    setStep('projectName');
    setConfig(getDefaultConfig());
    setError(null);
  }, []);

  /**
   * Initialize the wizard with a pre-set name and skip to language step.
   * Use this when the name is known from a previous step (e.g., AddAgentScreen).
   */
  const initWithName = useCallback((name: string) => {
    setConfig(c => ({ ...c, projectName: name }));
    setHasInitialName(true);
    setStep('language');
    setError(null);
  }, []);

  return {
    step,
    steps,
    currentIndex,
    config,
    error,
    hasInitialName,
    setProjectName,
    setLanguage,
    setSdk,
    setModelProvider,
    setApiKey,
    skipApiKey,
    setMemory,
    goBack,
    reset,
    initWithName,
  };
}
