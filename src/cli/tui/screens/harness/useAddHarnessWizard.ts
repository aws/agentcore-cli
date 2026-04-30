import type { HarnessModelProvider, NetworkMode, RuntimeAuthorizerType } from '../../../../schema';
import type { JwtConfig } from '../../components/jwt-config';
import type { AddHarnessConfig, AddHarnessStep, AdvancedSetting, ContainerMode } from './types';
import { DEFAULT_MODEL_IDS } from './types';
import { useCallback, useMemo, useState } from 'react';

const ADVANCED_SETTING_ORDER: AdvancedSetting[] = [
  'tools',
  'auth',
  'network',
  'lifecycle',
  'execution',
  'truncation',
  'session-storage',
];

const SETTING_TO_FIRST_STEP: Record<AdvancedSetting, AddHarnessStep> = {
  tools: 'tools-select',
  auth: 'authorizerType',
  network: 'network-mode',
  lifecycle: 'idle-timeout',
  execution: 'max-iterations',
  truncation: 'truncation-strategy',
  'session-storage': 'session-storage-path',
};

function getFirstAdvancedStep(settings: AdvancedSetting[]): AddHarnessStep | undefined {
  for (const setting of ADVANCED_SETTING_ORDER) {
    if (settings.includes(setting)) return SETTING_TO_FIRST_STEP[setting];
  }
  return undefined;
}

function getNextAdvancedStep(settings: AdvancedSetting[], after: AdvancedSetting): AddHarnessStep | undefined {
  const idx = ADVANCED_SETTING_ORDER.indexOf(after);
  const remaining = ADVANCED_SETTING_ORDER.slice(idx + 1);
  for (const setting of remaining) {
    if (settings.includes(setting)) return SETTING_TO_FIRST_STEP[setting];
  }
  return undefined;
}

function getDefaultConfig(): AddHarnessConfig {
  return {
    name: '',
    modelProvider: 'bedrock',
    modelId: DEFAULT_MODEL_IDS.bedrock,
  };
}

export function useAddHarnessWizard() {
  const [config, setConfig] = useState<AddHarnessConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddHarnessStep>('name');
  const [advancedSettings, setAdvancedSettingsState] = useState<AdvancedSetting[]>([]);

  const allSteps = useMemo(() => {
    const steps: AddHarnessStep[] = ['name', 'model-provider'];

    if (config.modelProvider !== 'bedrock') {
      steps.push('api-key-arn');
    }

    steps.push('container');
    if (config.containerMode === 'uri') {
      steps.push('container-uri');
    } else if (config.containerMode === 'dockerfile') {
      steps.push('container-dockerfile');
    }

    steps.push('memory');

    steps.push('advanced');

    if (advancedSettings.includes('tools')) {
      steps.push('tools-select');
      if (config.selectedTools?.includes('remote_mcp')) {
        steps.push('mcp-name', 'mcp-url');
      }
      if (config.selectedTools?.includes('agentcore_gateway')) {
        steps.push('gateway-arn');
        steps.push('gateway-outbound-auth');
        if (config.gatewayOutboundAuth === 'oauth') {
          steps.push('gateway-provider-arn', 'gateway-scopes');
        }
      }
    }

    if (advancedSettings.includes('auth')) {
      steps.push('authorizerType');
      if (config.authorizerType === 'CUSTOM_JWT') {
        steps.push('jwtConfig');
      }
    }

    if (advancedSettings.includes('network')) {
      steps.push('network-mode');
      if (config.networkMode === 'VPC') {
        steps.push('subnets', 'security-groups');
      }
    }

    if (advancedSettings.includes('lifecycle')) {
      steps.push('idle-timeout', 'max-lifetime');
    }

    if (advancedSettings.includes('execution')) {
      steps.push('max-iterations', 'max-tokens', 'timeout');
    }

    if (advancedSettings.includes('truncation')) {
      steps.push('truncation-strategy');
    }

    if (advancedSettings.includes('session-storage')) {
      steps.push('session-storage-path');
    }

    steps.push('confirm');

    return steps;
  }, [
    config.modelProvider,
    config.containerMode,
    config.authorizerType,
    config.networkMode,
    config.selectedTools,
    config.gatewayOutboundAuth,
    advancedSettings,
  ]);

  const currentIndex = allSteps.indexOf(step);

  const goBack = useCallback(() => {
    const idx = allSteps.indexOf(step);
    const prevStep = allSteps[idx - 1];
    if (prevStep) setStep(prevStep);
  }, [allSteps, step]);

  const nextStep = useCallback(
    (currentStep: AddHarnessStep): AddHarnessStep | undefined => {
      const idx = allSteps.indexOf(currentStep);
      return allSteps[idx + 1];
    },
    [allSteps]
  );

  const setName = useCallback(
    (name: string) => {
      setConfig(c => ({ ...c, name }));
      const next = nextStep('name');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setModelProvider = useCallback((modelProvider: HarnessModelProvider) => {
    setConfig(c => ({ ...c, modelProvider, modelId: DEFAULT_MODEL_IDS[modelProvider] }));
    if (modelProvider !== 'bedrock') {
      setStep('api-key-arn');
    } else {
      setStep('container');
    }
  }, []);

  const setApiKeyArn = useCallback(
    (apiKeyArn: string) => {
      setConfig(c => ({ ...c, apiKeyArn }));
      const next = nextStep('api-key-arn');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setContainerMode = useCallback((containerMode: ContainerMode) => {
    setConfig(c => ({ ...c, containerMode, containerUri: undefined, dockerfilePath: undefined }));
    if (containerMode === 'uri') {
      setStep('container-uri');
    } else if (containerMode === 'dockerfile') {
      setStep('container-dockerfile');
    } else {
      setStep('memory');
    }
  }, []);

  const setContainerUri = useCallback(
    (containerUri: string) => {
      setConfig(c => ({ ...c, containerUri }));
      const next = nextStep('container-uri');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setDockerfilePath = useCallback(
    (dockerfilePath: string) => {
      setConfig(c => ({ ...c, dockerfilePath }));
      const next = nextStep('container-dockerfile');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setAdvancedSettings = useCallback((settings: AdvancedSetting[]) => {
    setAdvancedSettingsState(settings);
    const firstAdvancedStep = getFirstAdvancedStep(settings);
    setStep(firstAdvancedStep ?? 'confirm');
  }, []);

  const setSelectedTools = useCallback(
    (selectedTools: string[]) => {
      setConfig(c => ({ ...c, selectedTools }));
      if (selectedTools.includes('remote_mcp')) {
        setStep('mcp-name');
      } else if (selectedTools.includes('agentcore_gateway')) {
        setStep('gateway-arn');
      } else {
        const next = getNextAdvancedStep(advancedSettings, 'tools');
        setStep(next ?? 'confirm');
      }
    },
    [advancedSettings]
  );

  const setMcpName = useCallback(
    (mcpName: string) => {
      setConfig(c => ({ ...c, mcpName }));
      const next = nextStep('mcp-name');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setMcpUrl = useCallback(
    (mcpUrl: string) => {
      setConfig(c => ({ ...c, mcpUrl }));
      if (config.selectedTools?.includes('agentcore_gateway')) {
        setStep('gateway-arn');
      } else {
        const next = getNextAdvancedStep(advancedSettings, 'tools');
        setStep(next ?? 'confirm');
      }
    },
    [advancedSettings, config.selectedTools]
  );

  const setGatewayArn = useCallback((gatewayArn: string) => {
    setConfig(c => ({ ...c, gatewayArn }));
    setStep('gateway-outbound-auth');
  }, []);

  const setGatewayOutboundAuth = useCallback(
    (authType: 'awsIam' | 'none' | 'oauth') => {
      setConfig(c => ({ ...c, gatewayOutboundAuth: authType }));
      if (authType === 'oauth') {
        setStep('gateway-provider-arn');
      } else {
        const next = getNextAdvancedStep(advancedSettings, 'tools');
        setStep(next ?? 'confirm');
      }
    },
    [advancedSettings]
  );

  const setGatewayProviderArn = useCallback((gatewayProviderArn: string) => {
    setConfig(c => ({ ...c, gatewayProviderArn }));
    setStep('gateway-scopes');
  }, []);

  const setGatewayScopes = useCallback(
    (gatewayScopes: string) => {
      setConfig(c => ({ ...c, gatewayScopes }));
      const next = getNextAdvancedStep(advancedSettings, 'tools');
      setStep(next ?? 'confirm');
    },
    [advancedSettings]
  );

  const setMemoryEnabled = useCallback((enabled: boolean) => {
    setConfig(c => ({ ...c, skipMemory: !enabled }));
    setStep('advanced');
  }, []);

  const setAuthorizerType = useCallback(
    (authorizerType: RuntimeAuthorizerType) => {
      setConfig(c => ({ ...c, authorizerType, jwtConfig: undefined }));
      if (authorizerType === 'CUSTOM_JWT') {
        setStep('jwtConfig');
      } else {
        const next = getNextAdvancedStep(advancedSettings, 'auth');
        setStep(next ?? 'confirm');
      }
    },
    [advancedSettings]
  );

  const setJwtConfig = useCallback(
    (jwtConfig: JwtConfig) => {
      setConfig(c => ({ ...c, jwtConfig }));
      const next = getNextAdvancedStep(advancedSettings, 'auth');
      setStep(next ?? 'confirm');
    },
    [advancedSettings]
  );

  const setNetworkMode = useCallback(
    (networkMode: NetworkMode) => {
      setConfig(c => ({ ...c, networkMode }));
      if (networkMode === 'VPC') {
        setStep('subnets');
      } else {
        const next = getNextAdvancedStep(advancedSettings, 'network');
        setStep(next ?? 'confirm');
      }
    },
    [advancedSettings]
  );

  const setSubnets = useCallback(
    (subnetsStr: string) => {
      const subnets = subnetsStr
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      setConfig(c => ({ ...c, subnets }));
      const next = nextStep('subnets');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setSecurityGroups = useCallback(
    (sgStr: string) => {
      const securityGroups = sgStr
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      setConfig(c => ({ ...c, securityGroups }));
      const next = nextStep('security-groups');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setIdleTimeout = useCallback(
    (idleTimeoutStr: string) => {
      const idleTimeout = parseInt(idleTimeoutStr, 10);
      setConfig(c => ({ ...c, idleTimeout }));
      const next = nextStep('idle-timeout');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setMaxLifetime = useCallback(
    (maxLifetimeStr: string) => {
      const maxLifetime = parseInt(maxLifetimeStr, 10);
      setConfig(c => ({ ...c, maxLifetime }));
      const next = nextStep('max-lifetime');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setMaxIterations = useCallback(
    (maxIterationsStr: string) => {
      const maxIterations = parseInt(maxIterationsStr, 10);
      setConfig(c => ({ ...c, maxIterations }));
      const next = nextStep('max-iterations');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setMaxTokens = useCallback(
    (maxTokensStr: string) => {
      const maxTokens = parseInt(maxTokensStr, 10);
      setConfig(c => ({ ...c, maxTokens }));
      const next = nextStep('max-tokens');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setTimeoutSeconds = useCallback(
    (timeoutStr: string) => {
      const timeoutSeconds = parseInt(timeoutStr, 10);
      setConfig(c => ({ ...c, timeoutSeconds }));
      const next = nextStep('timeout');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setTruncationStrategy = useCallback(
    (truncationStrategy: 'sliding_window' | 'summarization') => {
      setConfig(c => ({ ...c, truncationStrategy }));
      const next = nextStep('truncation-strategy');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setSessionStoragePath = useCallback(
    (sessionStoragePath: string) => {
      setConfig(c => ({ ...c, sessionStoragePath }));
      const next = nextStep('session-storage-path');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setStep('name');
    setAdvancedSettingsState([]);
  }, []);

  return {
    config,
    step,
    steps: allSteps,
    currentIndex,
    advancedSettings,
    goBack,
    setName,
    setModelProvider,
    setApiKeyArn,
    setContainerMode,
    setContainerUri,
    setDockerfilePath,
    setAdvancedSettings,
    setSelectedTools,
    setMcpName,
    setMcpUrl,
    setGatewayArn,
    setGatewayOutboundAuth,
    setGatewayProviderArn,
    setGatewayScopes,
    setMemoryEnabled,
    setAuthorizerType,
    setJwtConfig,
    setNetworkMode,
    setSubnets,
    setSecurityGroups,
    setIdleTimeout,
    setMaxLifetime,
    setMaxIterations,
    setMaxTokens,
    setTimeoutSeconds,
    setTruncationStrategy,
    setSessionStoragePath,
    reset,
  };
}
