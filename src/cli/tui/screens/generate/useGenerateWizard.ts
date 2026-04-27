import type { NetworkMode, RuntimeAuthorizerType } from '../../../../schema';
import { ProjectNameSchema, SessionStorageSchema } from '../../../../schema';
import type { JwtConfigOptions } from '../../../primitives/auth-utils';
import type { AdvancedSettingId, BuildType, GenerateConfig, GenerateStep, MemoryOption, ProtocolMode } from './types';
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
  const [advancedSettings, setAdvancedSettings] = useState<Set<AdvancedSettingId>>(new Set());

  const advancedSelected = advancedSettings.size > 0;

  // Steps depend on protocol, SDK, model provider, network mode, and whether we have an initial name
  // MCP skips sdk, modelProvider, apiKey, memory
  // Advanced sub-steps only appear for settings the user selected in the multi-select
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
      const subSteps: GenerateStep[] = [];
      // Dockerfile — only for Container builds when user selected it
      if (advancedSettings.has('dockerfile') && config.buildType === 'Container') {
        subSteps.push('dockerfile');
      }
      // Network — always networkMode, plus subnets/securityGroups for VPC
      if (advancedSettings.has('network')) {
        subSteps.push('networkMode');
        if (config.networkMode === 'VPC') {
          subSteps.push('subnets', 'securityGroups');
        }
      }
      // Headers
      if (advancedSettings.has('headers')) {
        subSteps.push('requestHeaderAllowlist');
      }
      // Auth
      if (advancedSettings.has('auth')) {
        subSteps.push('authorizerType');
      }
      // Lifecycle
      if (advancedSettings.has('lifecycle')) {
        subSteps.push('idleTimeout', 'maxLifetime');
      }
      // Filesystem
      if (advancedSettings.has('filesystem')) {
        subSteps.push('sessionStorageMountPath');
      }
      filtered = [...filtered.slice(0, afterAdvanced), ...subSteps, ...filtered.slice(afterAdvanced)];
    }
    // Add jwtConfig step after authorizerType when CUSTOM_JWT is selected
    if (config.authorizerType === 'CUSTOM_JWT' && filtered.includes('authorizerType')) {
      const authIndex = filtered.indexOf('authorizerType');
      filtered = [...filtered.slice(0, authIndex + 1), 'jwtConfig', ...filtered.slice(authIndex + 1)];
    }
    return filtered;
  }, [
    config.buildType,
    config.modelProvider,
    config.sdk,
    config.protocol,
    config.networkMode,
    config.authorizerType,
    hasInitialName,
    sdkSelected,
    advancedSelected,
    advancedSettings,
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
    setConfig(c => ({ ...c, buildType, dockerfile: undefined }));
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

  /** Navigate to the next step after the current one in the steps array */
  const goToNextStep = useCallback(
    (afterStep: GenerateStep) => {
      // Find the step after afterStep in the current steps array, or fall back to confirm
      const idx = steps.indexOf(afterStep);
      const next = idx >= 0 ? steps[idx + 1] : undefined;
      setStep(next ?? 'confirm');
    },
    [steps]
  );

  const setDockerfile = useCallback(
    (dockerfile: string | undefined) => {
      setConfig(c => ({ ...c, dockerfile }));
      setTimeout(() => goToNextStep('dockerfile'), 0);
    },
    [goToNextStep]
  );

  const setAdvanced = useCallback(
    (selectedIds: AdvancedSettingId[]) => {
      const selected = new Set(selectedIds);
      setAdvancedSettings(selected);
      if (selected.size === 0) {
        // No advanced settings — reset defaults and go to confirm
        setConfig(c => ({
          ...c,
          dockerfile: undefined,
          networkMode: 'PUBLIC',
          subnets: undefined,
          securityGroups: undefined,
          requestHeaderAllowlist: undefined,
          authorizerType: undefined,
          jwtConfig: undefined,
          idleRuntimeSessionTimeout: undefined,
          maxLifetime: undefined,
          sessionStorageMountPath: undefined,
        }));
        setStep('confirm');
      } else {
        // Navigate to first advanced sub-step — determined by the steps memo on next render.
        // Use setTimeout so the steps memo recalculates with the new advancedSettings first.
        setTimeout(() => {
          // The steps array hasn't updated yet, so we compute the first sub-step manually
          if (selected.has('dockerfile') && config.buildType === 'Container') {
            setStep('dockerfile');
          } else if (selected.has('network')) {
            setStep('networkMode');
          } else if (selected.has('headers')) {
            setStep('requestHeaderAllowlist');
          } else if (selected.has('auth')) {
            setStep('authorizerType');
          } else if (selected.has('lifecycle')) {
            setStep('idleTimeout');
          } else if (selected.has('filesystem')) {
            setStep('sessionStorageMountPath');
          } else {
            setStep('confirm');
          }
        }, 0);
      }
    },
    [config.buildType]
  );

  const setNetworkMode = useCallback(
    (networkMode: NetworkMode) => {
      setConfig(c => ({ ...c, networkMode }));
      if (networkMode === 'VPC') {
        setStep('subnets');
      } else {
        // Skip subnets/securityGroups, go to next step after networkMode
        // We need to find next step after where securityGroups would be, or after networkMode
        // Since steps array adapts, just go to next after networkMode
        setTimeout(() => goToNextStep('networkMode'), 0);
      }
    },
    [goToNextStep]
  );

  const setSubnets = useCallback((subnets: string[]) => {
    setConfig(c => ({ ...c, subnets }));
    setStep('securityGroups');
  }, []);

  const setSecurityGroups = useCallback(
    (securityGroups: string[]) => {
      setConfig(c => ({ ...c, securityGroups }));
      setTimeout(() => goToNextStep('securityGroups'), 0);
    },
    [goToNextStep]
  );

  const setRequestHeaderAllowlist = useCallback(
    (requestHeaderAllowlist: string[]) => {
      setConfig(c => ({ ...c, requestHeaderAllowlist }));
      setTimeout(() => goToNextStep('requestHeaderAllowlist'), 0);
    },
    [goToNextStep]
  );

  const skipRequestHeaderAllowlist = useCallback(() => {
    setTimeout(() => goToNextStep('requestHeaderAllowlist'), 0);
  }, [goToNextStep]);

  const setAuthorizerType = useCallback(
    (authorizerType: RuntimeAuthorizerType) => {
      setConfig(c => ({ ...c, authorizerType }));
      if (authorizerType === 'CUSTOM_JWT') {
        setStep('jwtConfig');
      } else {
        setConfig(c => ({ ...c, authorizerType, jwtConfig: undefined }));
        setTimeout(() => goToNextStep('authorizerType'), 0);
      }
    },
    [goToNextStep]
  );

  const setJwtConfig = useCallback(
    (jwtConfig: JwtConfigOptions) => {
      setConfig(c => ({ ...c, jwtConfig }));
      setTimeout(() => goToNextStep('jwtConfig'), 0);
    },
    [goToNextStep]
  );

  const setIdleTimeout = useCallback((value: number | undefined) => {
    setConfig(c => ({ ...c, idleRuntimeSessionTimeout: value }));
    setStep('maxLifetime');
  }, []);

  const skipIdleTimeout = useCallback(() => {
    setStep('maxLifetime');
  }, []);

  const setMaxLifetime = useCallback(
    (value: number | undefined) => {
      setConfig(c => ({ ...c, maxLifetime: value }));
      setTimeout(() => goToNextStep('maxLifetime'), 0);
    },
    [goToNextStep]
  );

  const skipMaxLifetime = useCallback(() => {
    setTimeout(() => goToNextStep('maxLifetime'), 0);
  }, [goToNextStep]);

  const setSessionStorageMountPath = useCallback(
    (value: string | undefined) => {
      if (value) {
        const result = SessionStorageSchema.shape.mountPath.safeParse(value);
        if (!result.success) {
          setError(result.error.issues[0]?.message ?? 'Invalid mount path');
          return false;
        }
      }
      setError(null);
      setConfig(c => ({ ...c, sessionStorageMountPath: value }));
      setTimeout(() => goToNextStep('sessionStorageMountPath'), 0);
      return true;
    },
    [goToNextStep]
  );

  const skipSessionStorageMountPath = useCallback(() => {
    setTimeout(() => goToNextStep('sessionStorageMountPath'), 0);
  }, [goToNextStep]);

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
    setAdvancedSettings(new Set());
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
    setDockerfile,
    setProtocol,
    setSdk,
    setModelProvider,
    setApiKey,
    skipApiKey,
    setMemory,
    setAdvanced,
    advancedSelected,
    advancedSettings,
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
    setSessionStorageMountPath,
    skipSessionStorageMountPath,
    goBack,
    reset,
    initWithName,
  };
}
