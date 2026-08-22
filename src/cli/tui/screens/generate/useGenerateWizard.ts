import type { NetworkMode, RuntimeAuthorizerType } from '../../../../schema';
import { ProjectNameSchema, SessionStorageSchema } from '../../../../schema';
import type { JwtConfigOptions } from '../../../primitives/auth-utils';
import { useFilesystemMountState } from '../../hooks/useFilesystemMountState';
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
  // How the runtime attaches to a capacity provider: none, an in-project sibling by name, or an
  // external ARN. Drives which CP sub-steps appear (see the steps memo).
  const [capacityProviderMode, setCapacityProviderMode] = useState<'none' | 'name' | 'arn'>('none');

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
      // Network — always networkMode, plus subnets/securityGroups for VPC. A capacity provider
      // supplies its own network topology, so the network steps are mutually exclusive with it:
      // when a CP is also selected, CP wins and the network steps are skipped.
      if (advancedSettings.has('network') && !advancedSettings.has('capacityProvider')) {
        subSteps.push('networkMode');
        if (config.networkMode === 'VPC') {
          subSteps.push('subnets', 'securityGroups');
          // vpcId is required by the schema for Container builds in VPC mode (CodeBuild cannot
          // infer the VPC from subnets). CodeZip builds no container, so it is not collected there.
          if (config.buildType === 'Container') {
            subSteps.push('vpcId');
          }
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
        subSteps.push(
          'sessionStorageMountPath',
          'efsArn',
          'efsMountPath',
          'efsAddAnother',
          's3Arn',
          's3MountPath',
          's3AddAnother'
        );
      }
      // Capacity provider — a CP select, an optional ARN entry, and volume mounts (only once attached)
      if (advancedSettings.has('capacityProvider')) {
        subSteps.push('capacityProvider');
        if (capacityProviderMode === 'arn') {
          subSteps.push('capacityProviderArn');
        }
        // CP volumes can only be mounted once the runtime is attached to a capacity provider.
        if (capacityProviderMode !== 'none') {
          subSteps.push('cpVolumeMounts');
        }
      }
      // Config bundle — no sub-steps needed, uses smart defaults
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
    config.language,
    config.protocol,
    config.networkMode,
    config.authorizerType,
    hasInitialName,
    sdkSelected,
    advancedSelected,
    advancedSettings,
    capacityProviderMode,
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
    goToNextStep: goToNextStep as (afterStep: string) => void,
    setStep: setStep as (step: string) => void,
  });

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
          vpcId: undefined,
          requestHeaderAllowlist: undefined,
          authorizerType: undefined,
          jwtConfig: undefined,
          idleRuntimeSessionTimeout: undefined,
          maxLifetime: undefined,
          sessionStorageMountPath: undefined,
          efsAccessPoints: undefined,
          s3AccessPoints: undefined,
          capacityProviderConfiguration: undefined,
          capacityProviderVolumes: undefined,
          withConfigBundle: undefined,
        }));
        setCapacityProviderMode('none');
        resetFilesystemState();
        setStep('confirm');
      } else {
        // Clear filesystem state if filesystem was deselected
        if (!selected.has('filesystem')) {
          setConfig(c => ({
            ...c,
            sessionStorageMountPath: undefined,
            efsAccessPoints: undefined,
            s3AccessPoints: undefined,
          }));
          resetFilesystemState();
        }
        // Clear capacity-provider state if it was deselected
        if (!selected.has('capacityProvider')) {
          setCapacityProviderMode('none');
          setConfig(c => ({ ...c, capacityProviderConfiguration: undefined, capacityProviderVolumes: undefined }));
        }
        // Config bundle has no sub-steps — set flag immediately
        setConfig(c => ({
          ...c,
          withConfigBundle: selected.has('configBundle') || undefined,
        }));
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
          } else if (selected.has('capacityProvider')) {
            setStep('capacityProvider');
          } else {
            setStep('confirm');
          }
        }, 0);
      }
    },
    [config.buildType, resetFilesystemState]
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
      // When the vpcId step is active (Container build) goToNextStep advances to it; otherwise it
      // advances past the network section — mirroring how subnets → securityGroups already works.
      setTimeout(() => goToNextStep('securityGroups'), 0);
    },
    [goToNextStep]
  );

  const setVpcId = useCallback(
    (vpcId: string) => {
      setConfig(c => ({ ...c, vpcId }));
      setTimeout(() => goToNextStep('vpcId'), 0);
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

  const setCapacityProvider = useCallback((id: string) => {
    if (id === '__none__') {
      setCapacityProviderMode('none');
      setConfig(c => ({ ...c, capacityProviderConfiguration: undefined, capacityProviderVolumes: undefined }));
      // CP is the last advanced sub-step, so None's next step is always confirm. Navigate directly
      // (not via goToNextStep) to avoid the steps-memo race when re-selecting None after a CP.
      setStep('confirm');
    } else if (id === '__arn__') {
      setCapacityProviderMode('arn');
      setStep('capacityProviderArn');
    } else {
      // In-project sibling by name. A CP supplies its own network topology, so networkMode is not
      // settable — clear any network selection so the runtime carries no networkMode/networkConfig.
      setCapacityProviderMode('name');
      setConfig(c => ({
        ...c,
        capacityProviderConfiguration: { capacityProviderName: id },
        networkMode: undefined,
        subnets: undefined,
        securityGroups: undefined,
        vpcId: undefined,
      }));
      // A non-none attachment always has cpVolumeMounts next; navigate directly (steps memo hasn't
      // recomputed with mode='name' yet, so goToNextStep would skip it).
      setStep('cpVolumeMounts');
    }
  }, []);

  const setCapacityProviderArn = useCallback(
    (arn: string) => {
      // A CP supplies its own network topology, so networkMode is not settable — clear any network
      // selection so the runtime carries no networkMode/networkConfig.
      setConfig(c => ({
        ...c,
        capacityProviderConfiguration: { capacityProviderArn: arn },
        networkMode: undefined,
        subnets: undefined,
        securityGroups: undefined,
        vpcId: undefined,
      }));
      setTimeout(() => goToNextStep('capacityProviderArn'), 0);
    },
    [goToNextStep]
  );

  const setCpVolumeMounts = useCallback(
    (volumes: NonNullable<GenerateConfig['capacityProviderVolumes']>) => {
      setConfig(c => ({ ...c, capacityProviderVolumes: volumes.length > 0 ? volumes : undefined }));
      setTimeout(() => goToNextStep('cpVolumeMounts'), 0);
    },
    [goToNextStep]
  );

  const goBack = useCallback(() => {
    setError(null);
    // efsMountPath: editing → review screen, adding → ARN entry
    if (step === 'efsMountPath') {
      resetFilesystemState();
      setStep(editingEfsIndex >= 0 ? 'efsAddAnother' : 'efsArn');
      return;
    }
    if (step === 's3MountPath') {
      resetFilesystemState();
      setStep(editingS3Index >= 0 ? 's3AddAnother' : 's3Arn');
      return;
    }
    // efsArn: editing → back to review; mounts exist → back to review; no mounts → step before efsArn
    if (step === 'efsArn') {
      if (editingEfsIndex >= 0) {
        resetFilesystemState();
        setStep('efsAddAnother');
      } else if ((config.efsAccessPoints?.length ?? 0) > 0) {
        setStep('efsAddAnother');
      } else {
        const prev = steps[steps.indexOf('efsArn') - 1];
        if (prev) setStep(prev);
      }
      return;
    }
    // efsAddAnother: always exit EFS sub-flow (step before efsArn)
    if (step === 'efsAddAnother') {
      const prev = steps[steps.indexOf('efsArn') - 1];
      if (prev) setStep(prev);
      return;
    }
    // s3Arn: editing → back to s3 review; S3 mounts exist → back to s3 review; else → EFS section
    if (step === 's3Arn') {
      if (editingS3Index >= 0) {
        resetFilesystemState();
        setStep('s3AddAnother');
      } else if ((config.s3AccessPoints?.length ?? 0) > 0) {
        setStep('s3AddAnother');
      } else if ((config.efsAccessPoints?.length ?? 0) > 0) {
        setStep('efsAddAnother');
      } else {
        setStep('efsArn');
      }
      return;
    }
    // s3AddAnother: always exit S3 sub-flow → back to EFS section end/start
    if (step === 's3AddAnother') {
      if ((config.efsAccessPoints?.length ?? 0) > 0) {
        setStep('efsAddAnother');
      } else {
        setStep('efsArn');
      }
      return;
    }
    const prevStep = steps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [
    config.efsAccessPoints,
    config.s3AccessPoints,
    currentIndex,
    editingEfsIndex,
    editingS3Index,
    step,
    steps,
    resetFilesystemState,
  ]);

  const reset = useCallback(() => {
    setStep('projectName');
    setConfig(getDefaultConfig());
    setError(null);
    setSdkSelected(false);
    setAdvancedSettings(new Set());
    setCapacityProviderMode('none');
    resetFilesystemState();
  }, [resetFilesystemState]);

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
    setVpcId,
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
    capacityProviderMode,
    setCapacityProvider,
    setCapacityProviderArn,
    setCpVolumeMounts,
    pendingEfsArn,
    editingEfsIndex,
    submitEfsArn,
    submitEfsMountPath,
    submitEfsAddAnother,
    pendingS3Arn,
    editingS3Index,
    submitS3Arn,
    submitS3MountPath,
    submitS3AddAnother,
    goBack,
    reset,
    initWithName,
  };
}
