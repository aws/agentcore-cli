import type { NetworkMode, RuntimeAuthorizerType } from '../../../../schema';
import { ProjectNameSchema } from '../../../../schema';
import type { JwtConfigOptions } from '../../../primitives/auth-utils';
import type { BuildType, GenerateConfig, GenerateStep, MemoryOption, ProtocolMode } from './types';
import { BASE_GENERATE_STEPS, getModelProviderOptionsForSdk } from './types';
import { useCallback, useMemo, useState } from 'react';

function getDefaultConfig(): GenerateConfig {
  return {
    projectName: '',
    buildType: 'CodeZip',
    protocol: 'HTTP',
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

  // Track if user has selected a framework (moved past sdk step)
  const [sdkSelected, setSdkSelected] = useState(false);
  const [advancedSelected, setAdvancedSelected] = useState(false);

  // Steps depend on protocol, SDK, model provider, network mode, and whether we have an initial name
  // MCP skips sdk, modelProvider, apiKey, memory
  // Filter out: projectName if initialName, apiKey for Bedrock, subnets/securityGroups for non-VPC
  const steps = useMemo(() => {
    let filtered = BASE_GENERATE_STEPS;
    if (hasInitialName) {
      filtered = filtered.filter(s => s !== 'projectName');
    }
    if (config.protocol === 'MCP') {
      filtered = filtered.filter(s => s !== 'sdk' && s !== 'modelProvider' && s !== 'apiKey');
    } else {
      if (config.modelProvider === 'Bedrock') {
        filtered = filtered.filter(s => s !== 'apiKey');
      }
      if (sdkSelected && config.sdk === 'Strands') {
        const advancedIndex = filtered.indexOf('advanced');
        filtered = [...filtered.slice(0, advancedIndex), 'memory', ...filtered.slice(advancedIndex)];
      }
    }
    if (advancedSelected) {
      const advancedIndex = filtered.indexOf('advanced');
      const afterAdvanced = advancedIndex + 1;
      const networkSteps: GenerateStep[] =
        config.networkMode === 'VPC' ? ['networkMode', 'subnets', 'securityGroups'] : ['networkMode'];
      filtered = [
        ...filtered.slice(0, afterAdvanced),
        ...networkSteps,
        'requestHeaderAllowlist',
        'authorizerType',
        'idleTimeout',
        'maxLifetime',
        ...filtered.slice(afterAdvanced),
      ];
    }
    // Add jwtConfig step after authorizerType when CUSTOM_JWT is selected
    if (config.authorizerType === 'CUSTOM_JWT') {
      const authIndex = filtered.indexOf('authorizerType');
      filtered = [...filtered.slice(0, authIndex + 1), 'jwtConfig', ...filtered.slice(authIndex + 1)];
    }
    return filtered;
  }, [
    config.modelProvider,
    config.sdk,
    config.protocol,
    config.networkMode,
    config.authorizerType,
    hasInitialName,
    sdkSelected,
    advancedSelected,
  ]);

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
    setStep('buildType');
  }, []);

  const setBuildType = useCallback((buildType: BuildType) => {
    setConfig(c => ({ ...c, buildType }));
    setStep('protocol');
  }, []);

  const setProtocol = useCallback((protocol: ProtocolMode) => {
    setConfig(c => ({ ...c, protocol, memory: protocol === 'MCP' ? 'none' : c.memory }));
    if (protocol === 'MCP') {
      setStep('advanced');
    } else {
      setStep('sdk');
    }
  }, []);

  const setSdk = useCallback((sdk: GenerateConfig['sdk']) => {
    setSdkSelected(true);
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
        setStep('advanced');
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
        setStep('advanced');
      }
    },
    [config.sdk]
  );

  const skipApiKey = useCallback(() => {
    if (config.sdk === 'Strands') {
      setStep('memory');
    } else {
      setStep('advanced');
    }
  }, [config.sdk]);

  const setMemory = useCallback((memory: MemoryOption) => {
    setConfig(c => ({ ...c, memory }));
    setStep('advanced');
  }, []);

  const setAdvanced = useCallback((wantsAdvanced: boolean) => {
    if (wantsAdvanced) {
      setAdvancedSelected(true);
      setStep('networkMode');
    } else {
      setAdvancedSelected(false);
      setConfig(c => ({
        ...c,
        networkMode: 'PUBLIC',
        subnets: undefined,
        securityGroups: undefined,
        requestHeaderAllowlist: undefined,
        idleRuntimeSessionTimeout: undefined,
        maxLifetime: undefined,
      }));
      setStep('confirm');
    }
  }, []);

  const setNetworkMode = useCallback((networkMode: NetworkMode) => {
    setConfig(c => ({ ...c, networkMode }));
    if (networkMode === 'VPC') {
      setStep('subnets');
    } else {
      setStep('requestHeaderAllowlist');
    }
  }, []);

  const setSubnets = useCallback((subnets: string[]) => {
    setConfig(c => ({ ...c, subnets }));
    setStep('securityGroups');
  }, []);

  const setSecurityGroups = useCallback((securityGroups: string[]) => {
    setConfig(c => ({ ...c, securityGroups }));
    setStep('requestHeaderAllowlist');
  }, []);

  const setRequestHeaderAllowlist = useCallback((requestHeaderAllowlist: string[]) => {
    setConfig(c => ({ ...c, requestHeaderAllowlist }));
    setStep('authorizerType');
  }, []);

  const skipRequestHeaderAllowlist = useCallback(() => {
    setStep('authorizerType');
  }, []);

  const setAuthorizerType = useCallback((authorizerType: RuntimeAuthorizerType) => {
    setConfig(c => ({ ...c, authorizerType }));
    if (authorizerType === 'CUSTOM_JWT') {
      setStep('jwtConfig');
    } else {
      setConfig(c => ({ ...c, authorizerType, jwtConfig: undefined }));
      setStep('idleTimeout');
    }
  }, []);

  const setJwtConfig = useCallback((jwtConfig: JwtConfigOptions) => {
    setConfig(c => ({ ...c, jwtConfig }));
    setStep('idleTimeout');
  }, []);

  const setIdleTimeout = useCallback((value: number | undefined) => {
    setConfig(c => ({ ...c, idleRuntimeSessionTimeout: value }));
    setStep('maxLifetime');
  }, []);

  const skipIdleTimeout = useCallback(() => {
    setStep('maxLifetime');
  }, []);

  const setMaxLifetime = useCallback((value: number | undefined) => {
    setConfig(c => ({ ...c, maxLifetime: value }));
    setStep('confirm');
  }, []);

  const skipMaxLifetime = useCallback(() => {
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
    setSdkSelected(false);
    setAdvancedSelected(false);
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
    setBuildType,
    setProtocol,
    setSdk,
    setModelProvider,
    setApiKey,
    skipApiKey,
    setMemory,
    setAdvanced,
    advancedSelected,
    setNetworkMode,
    setSubnets,
    setSecurityGroups,
    setRequestHeaderAllowlist,
    skipRequestHeaderAllowlist,
    setAuthorizerType,
    setJwtConfig,
    setIdleTimeout,
    skipIdleTimeout,
    setMaxLifetime,
    skipMaxLifetime,
    goBack,
    reset,
    initWithName,
  };
}
