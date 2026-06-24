import type { HarnessApiFormat, HarnessModelProvider, NetworkMode, RuntimeAuthorizerType } from '../../../../schema';
import type { JwtConfig } from '../../components/jwt-config';
import { HARNESS_FILESYSTEM_STEP_NAMES, useFilesystemMountState } from '../../hooks/useFilesystemMountState';
import type { AddHarnessConfig, AddHarnessStep, AdvancedSetting, ContainerMode } from './types';
import { DEFAULT_BEDROCK_MANTLE_MODEL_ID, DEFAULT_MODEL_IDS } from './types';
import { useCallback, useMemo, useState } from 'react';

const ADVANCED_SETTING_ORDER: AdvancedSetting[] = [
  'tools',
  'skills',
  'memory-managed-tuning',
  'memory-existing-tuning',
  'allowed-tools',
  'auth',
  'network',
  'lifecycle',
  'execution',
  'truncation',
  'session-storage',
];

const SETTING_TO_FIRST_STEP: Record<AdvancedSetting, AddHarnessStep> = {
  tools: 'tools-select',
  skills: 'skills-source-type',
  'memory-managed-tuning': 'memory-strategies',
  'memory-existing-tuning': 'memory-messages-count',
  'allowed-tools': 'allowed-tools',
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
    // Memory is opt-in: a new harness defaults to disabled (no memory). The user picks Managed or
    // Existing on the memory-mode step if they want it. Seeding disabled keeps the confirm summary
    // accurate when the user accepts the default.
    memory: { mode: 'disabled' as const },
  };
}

export function useAddHarnessWizard() {
  const [config, setConfig] = useState<AddHarnessConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddHarnessStep>('name');
  const [advancedSettings, setAdvancedSettingsState] = useState<AdvancedSetting[]>([]);

  const allSteps = useMemo(() => {
    const steps: AddHarnessStep[] = ['name', 'model-provider'];

    if (config.modelProvider === 'bedrock' || config.modelProvider === 'open_ai') {
      steps.push('api-format');
    }

    if (config.modelProvider !== 'bedrock') {
      steps.push('api-key-arn');
    }

    if (config.modelProvider === 'lite_llm') {
      steps.push('api-base', 'additional-params');
    }

    steps.push('container');
    if (config.containerMode === 'uri') {
      steps.push('container-uri');
    } else if (config.containerMode === 'dockerfile') {
      steps.push('container-dockerfile');
    }

    // Main path is just the mode pick. Managed defaults to the service's own strategy set (nothing
    // more to ask); existing REQUIRES a name/ARN so it's collected here; disabled needs nothing.
    // All other knobs (managed strategies/expiry/KMS, existing tuning) live under Advanced → Memory tuning.
    steps.push('memory-mode');
    if (config.memory?.mode === 'existing') {
      steps.push('memory-existing-ref');
    }

    steps.push('advanced');

    if (advancedSettings.includes('tools')) {
      steps.push('tools-select');
      if (config.selectedTools?.includes('remote_mcp')) {
        steps.push('mcp-name', 'mcp-url', 'mcp-headers');
      }
      if (config.selectedTools?.includes('agentcore_gateway')) {
        steps.push('gateway-arn');
        steps.push('gateway-outbound-auth');
        if (config.gatewayOutboundAuth === 'oauth') {
          steps.push('gateway-provider-arn', 'gateway-scopes');
        }
      }
    }

    if (advancedSettings.includes('skills')) {
      steps.push('skills-source-type');
      if (config.pendingSkillSourceType === 'path') {
        steps.push('skill-path');
      } else if (config.pendingSkillSourceType === 's3') {
        steps.push('skill-s3-uri');
      } else if (config.pendingSkillSourceType === 'git') {
        steps.push('skill-git-url', 'skill-git-path', 'skill-git-credential', 'skill-git-username');
      } else if (config.pendingSkillSourceType === 'aws_skills') {
        steps.push('skill-aws-skills-paths');
      }
      steps.push('skill-add-another');
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

    // Mode-scoped memory tuning (gated on). Only the advanced option matching the chosen memory mode is
    // offered (see AddHarnessScreen's filter), so these are mutually exclusive: managed and existing have
    // disjoint knob sets per the harness API.
    if (advancedSettings.includes('memory-managed-tuning') && config.memory?.mode === 'managed') {
      steps.push('memory-strategies', 'memory-event-expiry', 'memory-kms');
    }
    if (advancedSettings.includes('memory-existing-tuning') && config.memory?.mode === 'existing') {
      steps.push('memory-messages-count', 'memory-retrieval-top-k', 'memory-relevance-score');
    }

    if (advancedSettings.includes('allowed-tools')) {
      steps.push('allowed-tools');
    }

    if (advancedSettings.includes('lifecycle')) {
      steps.push('idle-timeout', 'max-lifetime');
    }

    if (advancedSettings.includes('execution')) {
      steps.push('max-iterations', 'max-tokens', 'timeout', 'temperature', 'top-p');
      if (config.modelProvider === 'gemini') {
        steps.push('top-k');
      }
      steps.push('model-max-tokens');
    }

    if (advancedSettings.includes('truncation')) {
      steps.push('truncation-strategy');
    }

    if (advancedSettings.includes('session-storage')) {
      steps.push('session-storage-path');
      steps.push('efs-arn', 'efs-mount-path', 'efs-add-another');
      steps.push('s3-arn', 's3-mount-path', 's3-add-another');
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
    config.pendingSkillSourceType,
    config.skills,
    config.memory?.mode,
    advancedSettings,
  ]);

  const currentIndex = allSteps.indexOf(step);

  const goToNextHarnessStep = useCallback(
    (afterStep: string) => {
      const idx = allSteps.indexOf(afterStep as AddHarnessStep);
      const next = idx >= 0 ? allSteps[idx + 1] : undefined;
      if (next) setStep(next);
    },
    [allSteps]
  );

  const {
    pendingEfsArn,
    pendingS3Arn,
    editingEfsIndex,
    editingS3Index,
    submitEfsArn,
    submitEfsMountPath,
    submitEfsAddAnother,
    submitS3Arn,
    submitS3MountPath,
    submitS3AddAnother,
    resetFilesystemState,
  } = useFilesystemMountState({
    currentStep: step,
    efsMounts: config.efsAccessPoints ?? [],
    s3Mounts: config.s3AccessPoints ?? [],
    setEfsMounts: updater => setConfig(c => ({ ...c, efsAccessPoints: updater(c.efsAccessPoints ?? []) })),
    setS3Mounts: updater => setConfig(c => ({ ...c, s3AccessPoints: updater(c.s3AccessPoints ?? []) })),
    goToNextStep: goToNextHarnessStep,
    setStep: setStep as (step: string) => void,
    stepNames: HARNESS_FILESYSTEM_STEP_NAMES,
  });

  const goBack = useCallback(() => {
    // EFS/S3 back navigation handled by the filesystem hook's auto-redirect effects.
    // For efs-mount-path and s3-mount-path, route based on editing state before reset.
    if (step === 'efs-mount-path') {
      resetFilesystemState();
      setStep(editingEfsIndex >= 0 ? 'efs-add-another' : 'efs-arn');
      return;
    }
    if (step === 's3-mount-path') {
      resetFilesystemState();
      setStep(editingS3Index >= 0 ? 's3-add-another' : 's3-arn');
      return;
    }
    if (step === 'efs-arn') {
      if (editingEfsIndex >= 0) {
        resetFilesystemState();
        setStep('efs-add-another');
      } else if ((config.efsAccessPoints?.length ?? 0) > 0) {
        setStep('efs-add-another');
      } else {
        const idx = allSteps.indexOf('efs-arn');
        const prev = allSteps[idx - 1];
        if (prev) setStep(prev);
      }
      return;
    }
    if (step === 'efs-add-another') {
      const idx = allSteps.indexOf('efs-arn');
      const prev = allSteps[idx - 1];
      if (prev) setStep(prev);
      return;
    }
    if (step === 's3-arn') {
      if (editingS3Index >= 0) {
        resetFilesystemState();
        setStep('s3-add-another');
      } else if ((config.s3AccessPoints?.length ?? 0) > 0) {
        setStep('s3-add-another');
      } else if ((config.efsAccessPoints?.length ?? 0) > 0) {
        setStep('efs-add-another');
      } else {
        setStep('efs-arn');
      }
      return;
    }
    if (step === 's3-add-another') {
      if ((config.efsAccessPoints?.length ?? 0) > 0) {
        setStep('efs-add-another');
      } else {
        setStep('efs-arn');
      }
      return;
    }
    if (step === 'skills-source-type') {
      if ((config.skills?.length ?? 0) > 0) {
        setStep('skill-add-another');
      } else {
        const idx = allSteps.indexOf('skills-source-type');
        const prev = allSteps[idx - 1];
        if (prev) setStep(prev);
      }
      return;
    }
    if (step === 'skill-add-another') {
      const idx = allSteps.indexOf('skills-source-type');
      const prev = allSteps[idx - 1];
      if (prev) setStep(prev);
      return;
    }
    const idx = allSteps.indexOf(step);
    const prevStep = allSteps[idx - 1];
    if (prevStep) setStep(prevStep);
  }, [
    allSteps,
    step,
    editingEfsIndex,
    editingS3Index,
    config.efsAccessPoints,
    config.s3AccessPoints,
    config.skills,
    resetFilesystemState,
  ]);

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
    setConfig(c => ({
      ...c,
      modelProvider,
      modelId: DEFAULT_MODEL_IDS[modelProvider],
      apiFormat: undefined,
      // apiBase / additionalParams only apply to lite_llm — clear them when switching away.
      ...(modelProvider !== 'lite_llm' && { apiBase: undefined, additionalParams: undefined }),
    }));
    // bedrock and open_ai both have an api-format step that sits before api-key-arn
    // in allSteps — route through it for BOTH (open_ai previously jumped straight to api-key-arn,
    // making api-format forward-unreachable and leaving a false ✓ on the skipped step).
    if (modelProvider === 'bedrock' || modelProvider === 'open_ai') {
      setStep('api-format');
    } else {
      setStep('api-key-arn');
    }
  }, []);

  const setApiFormat = useCallback(
    (apiFormat: HarnessApiFormat) => {
      let provider: HarnessModelProvider = 'bedrock';
      setConfig(c => {
        provider = c.modelProvider;
        if (c.modelProvider === 'bedrock') {
          const isMantle = apiFormat !== 'converse_stream';
          return {
            ...c,
            apiFormat: isMantle ? apiFormat : undefined,
            modelId: isMantle ? DEFAULT_BEDROCK_MANTLE_MODEL_ID : DEFAULT_MODEL_IDS.bedrock,
          };
        }
        return { ...c, apiFormat };
      });
      // Advance to the natural next step instead of hard-coding 'container'. For open_ai the next
      // step is the REQUIRED api-key-arn — hard-coding 'container' skipped it, so a Back→api-format
      // →select path reached Confirm with apiKeyArn undefined and failed hard at write time.
      const next = nextStep('api-format');
      if (next) setStep(next);
      else setStep(provider === 'bedrock' ? 'container' : 'api-key-arn');
    },
    [nextStep]
  );

  const setApiKeyArn = useCallback(
    (apiKeyArn: string) => {
      setConfig(c => ({ ...c, apiKeyArn }));
      const next = nextStep('api-key-arn');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setApiBase = useCallback(
    (apiBase: string) => {
      setConfig(c => ({ ...c, apiBase: apiBase || undefined }));
      const next = nextStep('api-base');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setAdditionalParams = useCallback(
    (additionalParams: Record<string, unknown> | undefined) => {
      setConfig(c => ({ ...c, additionalParams }));
      const next = nextStep('additional-params');
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
      // Route to the first memory step: the mode picker.
      setStep('memory-mode');
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

  const setAdvancedSettings = useCallback(
    (settings: AdvancedSetting[]) => {
      setAdvancedSettingsState(settings);
      if (!settings.includes('session-storage')) {
        setConfig(c => ({
          ...c,
          sessionStoragePath: undefined,
          efsAccessPoints: undefined,
          s3AccessPoints: undefined,
        }));
        resetFilesystemState();
      }
      const firstAdvancedStep = getFirstAdvancedStep(settings);
      setStep(firstAdvancedStep ?? 'confirm');
    },
    [resetFilesystemState]
  );

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

  const setMcpUrl = useCallback((mcpUrl: string) => {
    setConfig(c => ({ ...c, mcpUrl }));
    setStep('mcp-headers');
  }, []);

  const setMcpHeaders = useCallback(
    (headers: Record<string, string> | undefined) => {
      setConfig(c => ({ ...c, mcpHeaders: headers }));
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

  // --- Mode-first memory sub-flow setters ---

  const setMemoryMode = useCallback((mode: 'managed' | 'existing' | 'disabled') => {
    // Managed seeds nothing beyond the mode — strategies/expiry/KMS are opt-in under Advanced, and an
    // absent strategy set means "use the service default". Existing collects its required ref next.
    setConfig(c => ({ ...c, memory: { mode } }));
    if (mode === 'existing') {
      setStep('memory-existing-ref');
    } else {
      // Managed / disabled have nothing more on the main path → continue to Advanced.
      setStep('advanced');
    }
  }, []);

  const setMemoryStrategies = useCallback(
    (strategies: string[]) => {
      setConfig(c =>
        c.memory?.mode === 'managed'
          ? { ...c, memory: { ...c.memory, strategies: strategies.length > 0 ? strategies : undefined } }
          : c
      );
      const next = nextStep('memory-strategies');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setMemoryEventExpiry = useCallback(
    (raw: string) => {
      const days = raw.trim() === '' ? undefined : parseInt(raw, 10);
      setConfig(c => (c.memory?.mode === 'managed' ? { ...c, memory: { ...c.memory, eventExpiryDuration: days } } : c));
      const next = nextStep('memory-event-expiry');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setMemoryKms = useCallback(
    (raw: string) => {
      const encryptionKeyArn = raw.trim() === '' ? undefined : raw.trim();
      setConfig(c => (c.memory?.mode === 'managed' ? { ...c, memory: { ...c.memory, encryptionKeyArn } } : c));
      const next = nextStep('memory-kms');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setMemoryExistingRef = useCallback((raw: string) => {
    const value = raw.trim();
    // An ARN goes to `arn`, anything else is treated as a project memory name.
    const isArn = value.startsWith('arn:');
    setConfig(c => ({
      ...c,
      memory: { mode: 'existing', ...(isArn ? { arn: value } : { name: value }) },
    }));
    // Existing-ref is the last main-path memory step → continue to Advanced.
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

  const setTemperature = useCallback(
    (raw: string) => {
      const temperature = raw.trim() === '' ? undefined : parseFloat(raw);
      setConfig(c => ({ ...c, temperature }));
      const next = nextStep('temperature');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setTopP = useCallback(
    (raw: string) => {
      const topP = raw.trim() === '' ? undefined : parseFloat(raw);
      setConfig(c => ({ ...c, topP }));
      const next = nextStep('top-p');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setTopK = useCallback(
    (raw: string) => {
      const topK = raw.trim() === '' ? undefined : parseInt(raw, 10);
      setConfig(c => ({ ...c, topK }));
      const next = nextStep('top-k');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setModelMaxTokens = useCallback(
    (raw: string) => {
      const modelMaxTokens = raw.trim() === '' ? undefined : parseInt(raw, 10);
      setConfig(c => ({ ...c, modelMaxTokens }));
      const next = nextStep('model-max-tokens');
      if (next) setStep(next);
    },
    [nextStep]
  );

  // Existing-memory retrieval tuning. These steps appear only in existing mode, so the value is
  // written into the existing union arm (mirroring the managed setters above) — AddHarnessFlow reads
  // tuning from config.memory, not from flat fields.
  const setMessagesCount = useCallback(
    (raw: string) => {
      const messagesCount = raw.trim() === '' ? undefined : parseInt(raw, 10);
      setConfig(c => (c.memory?.mode === 'existing' ? { ...c, memory: { ...c.memory, messagesCount } } : c));
      const next = nextStep('memory-messages-count');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setMemoryTopK = useCallback(
    (raw: string) => {
      const topK = raw.trim() === '' ? undefined : parseInt(raw, 10);
      setConfig(c => (c.memory?.mode === 'existing' ? { ...c, memory: { ...c.memory, topK } } : c));
      const next = nextStep('memory-retrieval-top-k');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setMemoryRelevanceScore = useCallback(
    (raw: string) => {
      const relevanceScore = raw.trim() === '' ? undefined : parseFloat(raw);
      setConfig(c => (c.memory?.mode === 'existing' ? { ...c, memory: { ...c.memory, relevanceScore } } : c));
      const next = nextStep('memory-relevance-score');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setAllowedTools = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      const allowedTools =
        trimmed === ''
          ? undefined
          : trimmed
              .split(',')
              .map(s => s.trim())
              .filter(Boolean);
      setConfig(c => ({ ...c, allowedTools }));
      const next = nextStep('allowed-tools');
      if (next) setStep(next);
    },
    [nextStep]
  );

  const setTruncationStrategy = useCallback(
    (truncationStrategy: 'sliding_window' | 'summarization' | 'none') => {
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

  const setSkillSourceType = useCallback((sourceType: 'path' | 's3' | 'git' | 'aws_skills') => {
    setConfig(c => ({ ...c, pendingSkillSourceType: sourceType }));
    if (sourceType === 'path') setStep('skill-path');
    else if (sourceType === 's3') setStep('skill-s3-uri');
    else if (sourceType === 'aws_skills') setStep('skill-aws-skills-paths');
    else setStep('skill-git-url');
  }, []);

  const submitSkillPath = useCallback((path: string) => {
    setConfig(c => ({
      ...c,
      skills: [...(c.skills ?? []), { path }],
      pendingSkillSourceType: undefined,
    }));
    setStep('skill-add-another');
  }, []);

  const submitSkillS3 = useCallback((s3Uri: string) => {
    setConfig(c => ({
      ...c,
      skills: [...(c.skills ?? []), { s3Uri }],
      pendingSkillSourceType: undefined,
    }));
    setStep('skill-add-another');
  }, []);

  const submitSkillGitUrl = useCallback((gitUrl: string) => {
    setConfig(c => ({ ...c, pendingSkillGitUrl: gitUrl }));
    setStep('skill-git-path');
  }, []);

  const submitSkillGitPath = useCallback((gitPath: string) => {
    setConfig(c => ({ ...c, pendingSkillGitPath: gitPath || undefined }));
    setStep('skill-git-credential');
  }, []);

  const submitSkillGitCredential = useCallback((selection: string) => {
    if (selection === 'skip') {
      setConfig(c => ({ ...c, pendingSkillCredentialName: undefined }));
      setStep('skill-git-username');
    } else {
      // selection is a credential name (existing or newly created)
      setConfig(c => ({ ...c, pendingSkillCredentialName: selection }));
      setStep('skill-git-username');
    }
  }, []);

  const submitSkillGitUsername = useCallback((username: string) => {
    setConfig(c => {
      const skill: NonNullable<AddHarnessConfig['skills']>[number] = {
        gitUrl: c.pendingSkillGitUrl,
        ...(c.pendingSkillGitPath && { gitPath: c.pendingSkillGitPath }),
        ...(c.pendingSkillCredentialName && {
          credentialName: c.pendingSkillCredentialName,
          ...(username && { username }),
        }),
      };
      return {
        ...c,
        skills: [...(c.skills ?? []), skill],
        pendingSkillSourceType: undefined,
        pendingSkillGitUrl: undefined,
        pendingSkillGitPath: undefined,
        pendingSkillCredentialName: undefined,
      };
    });
    setStep('skill-add-another');
  }, []);

  const submitSkillAwsSkillsPaths = useCallback((pathsStr: string) => {
    const paths = pathsStr
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    setConfig(c => ({
      ...c,
      skills: [...(c.skills ?? []), { awsSkills: paths }],
      pendingSkillSourceType: undefined,
    }));
    setStep('skill-add-another');
  }, []);

  const submitSkillAddAnother = useCallback(
    (choice: string) => {
      if (choice === 'add') {
        setStep('skills-source-type');
      } else {
        const next = getNextAdvancedStep(advancedSettings, 'skills');
        setStep(next ?? 'confirm');
      }
    },
    [advancedSettings]
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setStep('name');
    setAdvancedSettingsState([]);
    resetFilesystemState();
  }, [resetFilesystemState]);

  return {
    config,
    step,
    steps: allSteps,
    currentIndex,
    advancedSettings,
    goBack,
    setName,
    setModelProvider,
    setApiFormat,
    setApiKeyArn,
    setApiBase,
    setAdditionalParams,
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
    setMemoryMode,
    setMemoryStrategies,
    setMemoryEventExpiry,
    setMemoryKms,
    setMemoryExistingRef,
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
    setTemperature,
    setTopP,
    setTopK,
    setModelMaxTokens,
    setMessagesCount,
    setMemoryTopK,
    setMemoryRelevanceScore,
    setAllowedTools,
    setMcpHeaders,
    setTruncationStrategy,
    setSessionStoragePath,
    pendingEfsArn,
    pendingS3Arn,
    editingEfsIndex,
    editingS3Index,
    submitEfsArn,
    submitEfsMountPath,
    submitEfsAddAnother,
    submitS3Arn,
    submitS3MountPath,
    submitS3AddAnother,
    setSkillSourceType,
    submitSkillPath,
    submitSkillS3,
    submitSkillGitUrl,
    submitSkillGitPath,
    submitSkillGitCredential,
    submitSkillGitUsername,
    submitSkillAwsSkillsPaths,
    submitSkillAddAnother,
    reset,
  };
}
