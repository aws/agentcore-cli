import { APP_DIR, ConfigIO } from '../../../../lib';
import type { ModelProvider, NetworkMode, RuntimeAuthorizerType, SDKFramework } from '../../../../schema';
import { AgentNameSchema, DEFAULT_MODEL_IDS, LIFECYCLE_TIMEOUT_MAX, LIFECYCLE_TIMEOUT_MIN } from '../../../../schema';
import { listBedrockAgentAliases, listBedrockAgents } from '../../../aws/bedrock-import';
import type { BedrockAgentSummary, BedrockAliasSummary } from '../../../aws/bedrock-import-types';
import { parseAndNormalizeHeaders, validateHeaderAllowlist } from '../../../commands/shared/header-utils';
import {
  parseCommaSeparatedList,
  validateSecurityGroupIds,
  validateSubnetIds,
} from '../../../commands/shared/vpc-utils';
import { BEDROCK_REGIONS, IMPORT_FRAMEWORK_OPTIONS } from '../../../operations/agent/import/constants';
import type { JwtConfigOptions } from '../../../primitives/auth-utils';
import { computeDefaultCredentialEnvVarName } from '../../../primitives/credential-utils';
import {
  ApiKeySecretInput,
  ConfirmReview,
  Cursor,
  Panel,
  PathInput,
  Screen,
  StepIndicator,
  TextInput,
  WizardMultiSelect,
  WizardSelect,
} from '../../components';
import type { SelectableItem } from '../../components';
import { JwtConfigInput, useJwtConfigFlow } from '../../components/jwt-config';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation, useProject } from '../../hooks';
import { generateUniqueName } from '../../utils';
import { BUILD_TYPE_OPTIONS, GenerateWizardUI, getWizardHelpText, useGenerateWizard } from '../generate';
import type { BuildType, MemoryOption } from '../generate';
import type { AdvancedSettingId } from '../generate/types';
import { ADVANCED_SETTING_OPTIONS, MEMORY_OPTIONS } from '../generate/types';
import type { AddAgentConfig, AddAgentStep, AgentType } from './types';
import {
  ADD_AGENT_STEP_LABELS,
  AGENT_TYPE_OPTIONS,
  DEFAULT_ENTRYPOINT,
  DEFAULT_PYTHON_VERSION,
  MODEL_PROVIDER_OPTIONS,
  NETWORK_MODE_OPTIONS,
  RUNTIME_AUTHORIZER_TYPE_OPTIONS,
} from './types';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { basename, resolve } from 'path';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
// Steps for BYO path only (no framework/language - user's code already has these baked in)
type ByoStep =
  | 'codeLocation'
  | 'buildType'
  | 'dockerfile'
  | 'modelProvider'
  | 'apiKey'
  | 'advanced'
  | 'networkMode'
  | 'subnets'
  | 'securityGroups'
  | 'requestHeaderAllowlist'
  | 'authorizerType'
  | 'jwtConfig'
  | 'idleTimeout'
  | 'maxLifetime'
  | 'sessionStorageMountPath'
  | 'confirm';

const INITIAL_STEPS: InitialStep[] = ['name', 'agentType'];
const BYO_BASE_STEPS: ByoStep[] = ['codeLocation', 'buildType', 'modelProvider', 'apiKey', 'advanced', 'confirm'];

export interface ComputeByoStepsInput {
  modelProvider: string;
  buildType: string;
  networkMode: string;
  authorizerType: string;
  advancedSettings: Set<AdvancedSettingId>;
}

/** Pure function to compute BYO wizard steps from config. Exported for testing. */
export function computeByoSteps(input: ComputeByoStepsInput): ByoStep[] {
  let steps = [...BYO_BASE_STEPS];
  if (input.modelProvider === 'Bedrock') {
    steps = steps.filter(s => s !== 'apiKey');
  }
  if (input.advancedSettings.size > 0) {
    const advancedIndex = steps.indexOf('advanced');
    const afterAdvanced = advancedIndex + 1;
    const subSteps: ByoStep[] = [];
    if (input.advancedSettings.has('dockerfile') && input.buildType === 'Container') {
      subSteps.push('dockerfile');
    }
    if (input.advancedSettings.has('network')) {
      subSteps.push('networkMode');
      if (input.networkMode === 'VPC') {
        subSteps.push('subnets', 'securityGroups');
      }
    }
    if (input.advancedSettings.has('headers')) {
      subSteps.push('requestHeaderAllowlist');
    }
    if (input.advancedSettings.has('auth')) {
      subSteps.push('authorizerType');
    }
    if (input.advancedSettings.has('lifecycle')) {
      subSteps.push('idleTimeout', 'maxLifetime');
    }
    if (input.advancedSettings.has('filesystem')) {
      subSteps.push('sessionStorageMountPath');
    }
    steps = [...steps.slice(0, afterAdvanced), ...subSteps, ...steps.slice(afterAdvanced)];
  }
  if (input.authorizerType === 'CUSTOM_JWT' && steps.includes('authorizerType')) {
    const authIndex = steps.indexOf('authorizerType');
    steps = [...steps.slice(0, authIndex + 1), 'jwtConfig', ...steps.slice(authIndex + 1)];
  }
  return steps;
}

type ImportStep =
  | 'region'
  | 'bedrockAgent'
  | 'bedrockAlias'
  | 'framework'
  | 'memory'
  | 'authorizerType'
  | 'jwtConfig'
  | 'confirm';
const BASE_IMPORT_STEPS: ImportStep[] = [
  'region',
  'bedrockAgent',
  'bedrockAlias',
  'framework',
  'memory',
  'authorizerType',
  'confirm',
];

export function AddAgentScreen({ existingAgentNames, onComplete, onExit }: AddAgentScreenProps) {
  // Phase 1: name + agentType selection
  const [name, setName] = useState('');
  const [agentType, setAgentType] = useState<AgentType | null>(null);
  const [initialStep, setInitialStep] = useState<InitialStep>('name');

  // Phase 2 (create path): delegate to generate wizard
  const generateWizard = useGenerateWizard({ initialName: name });

  // Phase 2 (byo path): BYO-specific state
  // Note: language/framework not needed for BYO - user's code already has these
  const [byoStep, setByoStep] = useState<ByoStep>('codeLocation');
  const [byoConfig, setByoConfig] = useState({
    codeLocation: '',
    entrypoint: DEFAULT_ENTRYPOINT,
    buildType: 'CodeZip' as BuildType,
    dockerfile: '' as string,
    modelProvider: 'Bedrock' as ModelProvider,
    apiKey: undefined as string | undefined,
    networkMode: 'PUBLIC' as NetworkMode,
    subnets: '' as string,
    securityGroups: '' as string,
    requestHeaderAllowlist: '' as string,
    idleTimeout: '' as string,
    maxLifetime: '' as string,
    sessionStorageMountPath: '' as string,
    withConfigBundle: undefined as boolean | undefined,
  });
  const [byoAdvancedSettings, setByoAdvancedSettings] = useState<Set<AdvancedSettingId>>(new Set());
  const [byoAuthorizerType, setByoAuthorizerType] = useState<RuntimeAuthorizerType>('AWS_IAM');
  const [byoJwtConfig, setByoJwtConfig] = useState<JwtConfigOptions | undefined>(undefined);

  const { project } = useProject();

  // State for project name (fetched from project spec for credential naming)
  const [projectName, setProjectName] = useState<string>('');

  // Fetch project name when component mounts
  useEffect(() => {
    const fetchProjectName = async () => {
      try {
        const configIO = new ConfigIO();
        const projectSpec = await configIO.readProjectSpec();
        setProjectName(projectSpec.name);
      } catch {
        // Ignore errors - project name will remain empty
      }
    };
    void fetchProjectName();
  }, []);

  // Phase 2 (import path): Import-specific state
  const [importStep, setImportStep] = useState<ImportStep>('region');
  const [importConfig, setImportConfig] = useState({
    region: '',
    bedrockAgentId: '',
    bedrockAgentName: '',
    bedrockAliasId: '',
    bedrockAliasName: '',
    framework: 'Strands' as SDKFramework,
    memory: 'none' as MemoryOption,
  });
  const importConfigRef = useRef(importConfig);
  useEffect(() => {
    importConfigRef.current = importConfig;
  }, [importConfig]);
  const [bedrockAgents, setBedrockAgents] = useState<BedrockAgentSummary[]>([]);
  const [bedrockAliases, setBedrockAliases] = useState<BedrockAliasSummary[]>([]);
  const [importAuthorizerType, setImportAuthorizerType] = useState<RuntimeAuthorizerType>('AWS_IAM');
  const [importJwtConfig, setImportJwtConfig] = useState<JwtConfigOptions | undefined>(undefined);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // Determine which phase/path we're in
  const isInitialPhase = agentType === null;
  const isCreatePath = agentType === 'create';
  const isByoPath = agentType === 'byo';
  const isImportPath = agentType === 'import';

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
        // Initialize BYO code location with app/<name>/ to match project convention
        setByoConfig(c => ({ ...c, codeLocation: `${APP_DIR}/${name}/` }));
      }
      // Import path starts at 'region' step by default
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
      buildType: generateWizard.config.buildType,
      ...(generateWizard.config.buildType === 'Container' &&
        generateWizard.config.dockerfile && {
          dockerfile: generateWizard.config.dockerfile,
        }),
      protocol: generateWizard.config.protocol,
      framework: generateWizard.config.sdk,
      modelProvider: generateWizard.config.modelProvider,
      apiKey: generateWizard.config.apiKey,
      networkMode: generateWizard.config.networkMode,
      subnets: generateWizard.config.networkMode === 'VPC' ? generateWizard.config.subnets : undefined,
      securityGroups: generateWizard.config.networkMode === 'VPC' ? generateWizard.config.securityGroups : undefined,
      requestHeaderAllowlist: generateWizard.config.requestHeaderAllowlist,
      ...(generateWizard.config.authorizerType &&
        generateWizard.config.authorizerType !== 'AWS_IAM' && {
          authorizerType: generateWizard.config.authorizerType,
        }),
      ...(generateWizard.config.authorizerType === 'CUSTOM_JWT' &&
        generateWizard.config.jwtConfig && {
          jwtConfig: generateWizard.config.jwtConfig,
        }),
      idleRuntimeSessionTimeout: generateWizard.config.idleRuntimeSessionTimeout,
      maxLifetime: generateWizard.config.maxLifetime,
      sessionStorageMountPath: generateWizard.config.sessionStorageMountPath,
      withConfigBundle: generateWizard.config.withConfigBundle,
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

  // BYO steps filtering (apiKey for Bedrock, advanced sub-steps based on multi-select, jwtConfig for CUSTOM_JWT)
  const byoAdvancedActive = byoAdvancedSettings.size > 0;
  const byoSteps = useMemo(
    () =>
      computeByoSteps({
        modelProvider: byoConfig.modelProvider,
        buildType: byoConfig.buildType,
        networkMode: byoConfig.networkMode,
        authorizerType: byoAuthorizerType,
        advancedSettings: byoAdvancedSettings,
      }),
    [
      byoConfig.buildType,
      byoConfig.modelProvider,
      byoConfig.networkMode,
      byoAdvancedActive,
      byoAdvancedSettings,
      byoAuthorizerType,
    ]
  );

  const byoCurrentIndex = byoSteps.indexOf(byoStep);

  /** Navigate to the next step after the given step in the BYO steps array */
  const goToNextByoStep = useCallback(
    (afterStep: ByoStep) => {
      const idx = byoSteps.indexOf(afterStep);
      const next = idx >= 0 ? byoSteps[idx + 1] : undefined;
      setByoStep(next ?? 'confirm');
    },
    [byoSteps]
  );

  // Advanced multi-select items — filter out dockerfile when not a Container build
  const byoAdvancedItems: SelectableItem[] = useMemo(
    () =>
      ADVANCED_SETTING_OPTIONS.filter(o => o.id !== 'dockerfile' || byoConfig.buildType === 'Container').map(o => ({
        id: o.id,
        title: o.title,
        description: o.description,
      })),
    [byoConfig.buildType]
  );

  // BYO build type options
  const buildTypeItems: SelectableItem[] = useMemo(
    () =>
      BUILD_TYPE_OPTIONS.map(o => ({
        id: o.id,
        title: o.title,
        description: o.description,
      })),
    []
  );

  // BYO model provider options - show ALL providers since we don't know the framework
  const modelProviderItems: SelectableItem[] = useMemo(
    () =>
      MODEL_PROVIDER_OPTIONS.map(o => ({
        id: o.id,
        title: o.title,
        description: o.description,
      })),
    []
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
    // For BYO, language/framework are not asked - we default to Python/Strands
    // since the actual values don't matter for BYO (code already exists)
    const requestHeaderAllowlist = parseAndNormalizeHeaders(byoConfig.requestHeaderAllowlist);
    const config: AddAgentConfig = {
      name,
      agentType: 'byo',
      codeLocation: byoConfig.codeLocation,
      entrypoint: byoConfig.entrypoint,
      language: 'Python', // Default - not used for BYO agents
      buildType: byoConfig.buildType,
      ...(byoConfig.buildType === 'Container' && byoConfig.dockerfile && { dockerfile: byoConfig.dockerfile }),
      protocol: 'HTTP', // Default for BYO agents
      framework: 'Strands', // Default - not used for BYO agents
      modelProvider: byoConfig.modelProvider,
      apiKey: byoConfig.apiKey,
      networkMode: byoConfig.networkMode,
      subnets: byoConfig.networkMode === 'VPC' ? parseCommaSeparatedList(byoConfig.subnets) : undefined,
      securityGroups: byoConfig.networkMode === 'VPC' ? parseCommaSeparatedList(byoConfig.securityGroups) : undefined,
      ...(requestHeaderAllowlist.length > 0 && { requestHeaderAllowlist }),
      ...(byoAuthorizerType !== 'AWS_IAM' && { authorizerType: byoAuthorizerType }),
      ...(byoAuthorizerType === 'CUSTOM_JWT' && byoJwtConfig && { jwtConfig: byoJwtConfig }),
      ...(byoConfig.idleTimeout && { idleRuntimeSessionTimeout: Number(byoConfig.idleTimeout) }),
      ...(byoConfig.maxLifetime && { maxLifetime: Number(byoConfig.maxLifetime) }),
      ...(byoConfig.sessionStorageMountPath && { sessionStorageMountPath: byoConfig.sessionStorageMountPath }),
      ...(byoConfig.withConfigBundle && { withConfigBundle: true }),
      pythonVersion: DEFAULT_PYTHON_VERSION,
      memory: 'none',
    };
    onComplete(config);
  }, [name, byoConfig, byoAuthorizerType, byoJwtConfig, onComplete]);

  const buildTypeNav = useListNavigation({
    items: buildTypeItems,
    onSelect: item => {
      const build = item.id as BuildType;
      setByoConfig(c => ({ ...c, buildType: build, dockerfile: '' }));
      setByoStep('modelProvider');
    },
    onExit: handleByoBack,
    isActive: isByoPath && byoStep === 'buildType',
  });

  const modelProviderNav = useListNavigation({
    items: modelProviderItems,
    onSelect: item => {
      const provider = item.id as ModelProvider;
      setByoConfig(c => ({ ...c, modelProvider: provider }));
      if (provider !== 'Bedrock') {
        setByoStep('apiKey');
      } else {
        setByoStep('advanced');
      }
    },
    onExit: handleByoBack,
    isActive: isByoPath && byoStep === 'modelProvider',
  });

  // Network mode options for BYO path
  const networkModeItems: SelectableItem[] = useMemo(
    () =>
      NETWORK_MODE_OPTIONS.map(o => ({
        id: o.id,
        title: o.title,
        description: o.description,
      })),
    []
  );

  const advancedNav = useMultiSelectNavigation({
    items: byoAdvancedItems,
    getId: item => item.id,
    onConfirm: selectedIds => {
      const selected = new Set(selectedIds as AdvancedSettingId[]);
      setByoAdvancedSettings(selected);
      if (selected.size === 0) {
        // No advanced settings — reset defaults and go to confirm
        setByoConfig(c => ({
          ...c,
          dockerfile: '',
          networkMode: 'PUBLIC' as NetworkMode,
          subnets: '',
          securityGroups: '',
          requestHeaderAllowlist: '',
          idleTimeout: '',
          maxLifetime: '',
          sessionStorageMountPath: '',
          withConfigBundle: undefined,
        }));
        setByoAuthorizerType('AWS_IAM');
        setByoJwtConfig(undefined);
        setByoStep('confirm');
      } else {
        // Config bundle has no sub-steps — set flag immediately
        setByoConfig(c => ({ ...c, withConfigBundle: selected.has('configBundle') || undefined }));
        // Navigate to first advanced sub-step (steps memo hasn't updated yet)
        setTimeout(() => {
          if (selected.has('dockerfile') && byoConfig.buildType === 'Container') {
            setByoStep('dockerfile');
          } else if (selected.has('network')) {
            setByoStep('networkMode');
          } else if (selected.has('headers')) {
            setByoStep('requestHeaderAllowlist');
          } else if (selected.has('auth')) {
            setByoStep('authorizerType');
          } else if (selected.has('lifecycle')) {
            setByoStep('idleTimeout');
          } else if (selected.has('filesystem')) {
            setByoStep('sessionStorageMountPath');
          } else {
            setByoStep('confirm');
          }
        }, 0);
      }
    },
    onExit: handleByoBack,
    isActive: isByoPath && byoStep === 'advanced',
    requireSelection: false,
  });

  const networkModeNav = useListNavigation({
    items: networkModeItems,
    onSelect: item => {
      const mode = item.id as NetworkMode;
      setByoConfig(c => ({ ...c, networkMode: mode }));
      if (mode === 'VPC') {
        setByoStep('subnets');
      } else {
        // Skip subnets/securityGroups — go to next step after networkMode
        setTimeout(() => goToNextByoStep('networkMode'), 0);
      }
    },
    onExit: handleByoBack,
    isActive: isByoPath && byoStep === 'networkMode',
  });

  // Authorizer type options for BYO path
  const authorizerTypeItems: SelectableItem[] = useMemo(
    () => RUNTIME_AUTHORIZER_TYPE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const authorizerTypeNav = useListNavigation({
    items: authorizerTypeItems,
    onSelect: item => {
      const authType = item.id as RuntimeAuthorizerType;
      setByoAuthorizerType(authType);
      if (authType === 'CUSTOM_JWT') {
        setByoStep('jwtConfig');
      } else {
        setByoJwtConfig(undefined);
        setTimeout(() => goToNextByoStep('authorizerType'), 0);
      }
    },
    onExit: handleByoBack,
    isActive: isByoPath && byoStep === 'authorizerType',
  });

  // JWT config flow for BYO path
  const byoJwtFlow = useJwtConfigFlow({
    onComplete: jwtConfig => {
      setByoJwtConfig(jwtConfig);
      setTimeout(() => goToNextByoStep('jwtConfig'), 0);
    },
    onBack: () => {
      setByoStep('authorizerType');
    },
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: handleByoComplete,
    onExit: handleByoBack,
    isActive: isByoPath && byoStep === 'confirm',
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Import Path
  // ─────────────────────────────────────────────────────────────────────────────

  // Compute import steps dynamically (add jwtConfig after authorizerType when CUSTOM_JWT selected)
  const importSteps = useMemo(() => {
    let steps = [...BASE_IMPORT_STEPS];
    if (importAuthorizerType === 'CUSTOM_JWT') {
      const authIndex = steps.indexOf('authorizerType');
      steps = [...steps.slice(0, authIndex + 1), 'jwtConfig', ...steps.slice(authIndex + 1)];
    }
    return steps;
  }, [importAuthorizerType]);

  const importCurrentIndex = importSteps.indexOf(importStep);

  const handleImportBack = useCallback(() => {
    if (importCurrentIndex === 0) {
      setAgentType(null);
      setInitialStep('agentType');
    } else {
      const prevStep = importSteps[importCurrentIndex - 1];
      if (prevStep) setImportStep(prevStep);
    }
  }, [importCurrentIndex, importSteps]);

  // Region selection items
  const regionItems: SelectableItem[] = useMemo(
    () => BEDROCK_REGIONS.map(r => ({ id: r.id, title: `${r.title} (${r.id})` })),
    []
  );

  const regionNav = useListNavigation({
    items: regionItems,
    onSelect: item => {
      setImportConfig(c => ({ ...c, region: item.id }));
      setImportStep('bedrockAgent');
      setImportLoading(true);
      setImportError(null);
      void listBedrockAgents(item.id)
        .then(agents => {
          setBedrockAgents(agents);
          setImportLoading(false);
        })
        .catch(err => {
          setImportError(err instanceof Error ? err.message : 'Failed to list agents');
          setImportLoading(false);
        });
    },
    onExit: handleImportBack,
    isActive: isImportPath && importStep === 'region',
  });

  // Agent selection items
  const agentItems: SelectableItem[] = useMemo(
    () =>
      bedrockAgents.map(a => ({
        id: a.agentId,
        title: a.agentName || a.agentId,
        description: a.description,
      })),
    [bedrockAgents]
  );

  const agentNav = useListNavigation({
    items: agentItems,
    onSelect: item => {
      const selected = bedrockAgents.find(a => a.agentId === item.id);
      setImportConfig(c => ({ ...c, bedrockAgentId: item.id, bedrockAgentName: selected?.agentName ?? item.id }));
      setImportStep('bedrockAlias');
      setImportLoading(true);
      setImportError(null);
      void listBedrockAgentAliases(importConfigRef.current.region, item.id)
        .then(aliases => {
          setBedrockAliases(aliases);
          setImportLoading(false);
        })
        .catch(err => {
          setImportError(err instanceof Error ? err.message : 'Failed to list aliases');
          setImportLoading(false);
        });
    },
    onExit: handleImportBack,
    isActive: isImportPath && importStep === 'bedrockAgent' && !importLoading,
  });

  // Alias selection items
  const aliasItems: SelectableItem[] = useMemo(
    () =>
      bedrockAliases.map(a => ({
        id: a.aliasId,
        title: a.aliasName || a.aliasId,
        description: a.description,
      })),
    [bedrockAliases]
  );

  const aliasNav = useListNavigation({
    items: aliasItems,
    onSelect: item => {
      const selected = bedrockAliases.find(a => a.aliasId === item.id);
      setImportConfig(c => ({ ...c, bedrockAliasId: item.id, bedrockAliasName: selected?.aliasName ?? item.id }));
      setImportStep('framework');
    },
    onExit: handleImportBack,
    isActive: isImportPath && importStep === 'bedrockAlias' && !importLoading,
  });

  // Framework selection for import (subset)
  const importFrameworkItems: SelectableItem[] = useMemo(
    () => IMPORT_FRAMEWORK_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const importFrameworkNav = useListNavigation({
    items: importFrameworkItems,
    onSelect: item => {
      setImportConfig(c => ({ ...c, framework: item.id as SDKFramework }));
      setImportStep('memory');
    },
    onExit: handleImportBack,
    isActive: isImportPath && importStep === 'framework',
  });

  // Memory selection for import (reuse MEMORY_OPTIONS)
  const importMemoryItems: SelectableItem[] = useMemo(
    () => MEMORY_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const importMemoryNav = useListNavigation({
    items: importMemoryItems,
    onSelect: item => {
      setImportConfig(c => ({ ...c, memory: item.id as MemoryOption }));
      setImportStep('authorizerType');
    },
    onExit: handleImportBack,
    isActive: isImportPath && importStep === 'memory',
  });

  // Authorizer type selection for import path (reuse same items)
  const importAuthorizerTypeNav = useListNavigation({
    items: authorizerTypeItems,
    onSelect: item => {
      const authType = item.id as RuntimeAuthorizerType;
      setImportAuthorizerType(authType);
      if (authType === 'CUSTOM_JWT') {
        setImportStep('jwtConfig');
      } else {
        setImportJwtConfig(undefined);
        setImportStep('confirm');
      }
    },
    onExit: handleImportBack,
    isActive: isImportPath && importStep === 'authorizerType',
  });

  // JWT config flow for import path
  const importJwtFlow = useJwtConfigFlow({
    onComplete: jwtConfig => {
      setImportJwtConfig(jwtConfig);
      setImportStep('confirm');
    },
    onBack: () => {
      setImportStep('authorizerType');
    },
  });

  const handleImportComplete = useCallback(() => {
    const config: AddAgentConfig = {
      name,
      agentType: 'import',
      codeLocation: `${APP_DIR}/${name}/`,
      entrypoint: 'main.py',
      language: 'Python',
      buildType: 'CodeZip',
      protocol: 'HTTP',
      framework: importConfig.framework,
      modelProvider: 'Bedrock',
      pythonVersion: DEFAULT_PYTHON_VERSION,
      memory: importConfig.memory,
      bedrockAgentId: importConfig.bedrockAgentId,
      bedrockAliasId: importConfig.bedrockAliasId,
      bedrockRegion: importConfig.region,
      ...(importAuthorizerType !== 'AWS_IAM' && { authorizerType: importAuthorizerType }),
      ...(importAuthorizerType === 'CUSTOM_JWT' && importJwtConfig && { jwtConfig: importJwtConfig }),
    };
    onComplete(config);
  }, [name, importConfig, importAuthorizerType, importJwtConfig, onComplete]);

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: handleImportComplete,
    onExit: handleImportBack,
    isActive: isImportPath && importStep === 'confirm',
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
    if (isImportPath) {
      if (importStep === 'confirm') return HELP_TEXT.CONFIRM_CANCEL;
      if (importStep === 'jwtConfig') {
        if (importJwtFlow.subStep === 'constraintPicker') return HELP_TEXT.MULTI_SELECT;
        if (importJwtFlow.subStep === 'customClaims') {
          return importJwtFlow.claimsManagerMode === 'add' || importJwtFlow.claimsManagerMode === 'edit'
            ? '↑/↓ field · ←/→ cycle · Enter next/save · Esc cancel'
            : 'Navigate · Enter select · Esc back';
        }
        return HELP_TEXT.TEXT_INPUT;
      }
      return HELP_TEXT.NAVIGATE_SELECT;
    }
    // BYO path
    if (byoStep === 'jwtConfig') {
      if (byoJwtFlow.subStep === 'constraintPicker') return HELP_TEXT.MULTI_SELECT;
      if (byoJwtFlow.subStep === 'customClaims') {
        return byoJwtFlow.claimsManagerMode === 'add' || byoJwtFlow.claimsManagerMode === 'edit'
          ? '↑/↓ field · ←/→ cycle · Enter next/save · Esc cancel'
          : 'Navigate · Enter select · Esc back';
      }
      return HELP_TEXT.TEXT_INPUT;
    }
    if (
      byoStep === 'codeLocation' ||
      byoStep === 'dockerfile' ||
      byoStep === 'apiKey' ||
      byoStep === 'subnets' ||
      byoStep === 'securityGroups' ||
      byoStep === 'requestHeaderAllowlist' ||
      byoStep === 'idleTimeout' ||
      byoStep === 'maxLifetime' ||
      byoStep === 'sessionStorageMountPath'
    ) {
      return HELP_TEXT.TEXT_INPUT;
    }
    if (byoStep === 'advanced') {
      return 'Space toggle · Enter confirm · Esc back';
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
    if (isImportPath) {
      const allSteps: AddAgentStep[] = ['name', 'agentType', ...importSteps];
      return <StepIndicator steps={allSteps} currentStep={importStep} labels={ADD_AGENT_STEP_LABELS} />;
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
            schema={AgentNameSchema}
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
        exitEnabled={false}
      >
        <Panel>
          <WizardSelect title="Select agent type" items={agentTypeItems} selectedIndex={agentTypeNav.selectedIndex} />
        </Panel>
      </Screen>
    );
  }

  // Create path: delegate to GenerateWizardUI
  // Disable Screen's exit handler - GenerateWizardUI handles its own back navigation
  if (isCreatePath) {
    return (
      <Screen
        title="Add Agent"
        onExit={onExit}
        helpText={getHelpText()}
        headerContent={renderStepIndicator()}
        exitEnabled={false}
      >
        <GenerateWizardUI
          wizard={generateWizard}
          onBack={handleGenerateBack}
          onConfirm={handleGenerateComplete}
          isActive={true}
          credentialProjectName={projectName}
        />
      </Screen>
    );
  }

  // Import path
  if (isImportPath) {
    return (
      <Screen
        title="Add Agent"
        onExit={onExit}
        helpText={getHelpText()}
        headerContent={renderStepIndicator()}
        exitEnabled={false}
      >
        <Panel>
          {importStep === 'region' && (
            <WizardSelect title="Select AWS region" items={regionItems} selectedIndex={regionNav.selectedIndex} />
          )}

          {importStep === 'bedrockAgent' && importLoading && (
            <Box>
              <Spinner type="dots" />
              <Text> Loading agents...</Text>
            </Box>
          )}
          {importStep === 'bedrockAgent' && importError && <Text color="red">Error: {importError}</Text>}
          {importStep === 'bedrockAgent' && !importLoading && !importError && agentItems.length === 0 && (
            <Text color="yellow">No agents found in {importConfig.region}. Press Esc to go back.</Text>
          )}
          {importStep === 'bedrockAgent' && !importLoading && !importError && agentItems.length > 0 && (
            <WizardSelect title="Select Bedrock Agent" items={agentItems} selectedIndex={agentNav.selectedIndex} />
          )}

          {importStep === 'bedrockAlias' && importLoading && (
            <Box>
              <Spinner type="dots" />
              <Text> Loading aliases...</Text>
            </Box>
          )}
          {importStep === 'bedrockAlias' && importError && <Text color="red">Error: {importError}</Text>}
          {importStep === 'bedrockAlias' && !importLoading && !importError && aliasItems.length === 0 && (
            <Text color="yellow">No aliases found. Press Esc to go back.</Text>
          )}
          {importStep === 'bedrockAlias' && !importLoading && !importError && aliasItems.length > 0 && (
            <WizardSelect title="Select Agent Alias" items={aliasItems} selectedIndex={aliasNav.selectedIndex} />
          )}

          {importStep === 'framework' && (
            <WizardSelect
              title="Select framework"
              items={importFrameworkItems}
              selectedIndex={importFrameworkNav.selectedIndex}
            />
          )}

          {importStep === 'memory' && (
            <WizardSelect
              title="Select memory configuration"
              items={importMemoryItems}
              selectedIndex={importMemoryNav.selectedIndex}
            />
          )}

          {importStep === 'authorizerType' && (
            <WizardSelect
              title="Select inbound auth mode"
              items={authorizerTypeItems}
              selectedIndex={importAuthorizerTypeNav.selectedIndex}
            />
          )}

          {importStep === 'jwtConfig' && (
            <JwtConfigInput
              subStep={importJwtFlow.subStep}
              steps={importJwtFlow.steps}
              selectedConstraints={importJwtFlow.selectedConstraints}
              customClaims={importJwtFlow.customClaims}
              discoveryUrl={importJwtFlow.discoveryUrl}
              audience={importJwtFlow.audience}
              clients={importJwtFlow.clients}
              scopes={importJwtFlow.scopes}
              onDiscoveryUrl={importJwtFlow.handlers.handleDiscoveryUrl}
              onConstraintsPicked={importJwtFlow.handlers.handleConstraintsPicked}
              onAudience={importJwtFlow.handlers.handleAudience}
              onClients={importJwtFlow.handlers.handleClients}
              onScopes={importJwtFlow.handlers.handleScopes}
              onCustomClaimsDone={importJwtFlow.handlers.handleCustomClaimsDone}
              onClientId={importJwtFlow.handlers.handleClientId}
              onClientIdSkip={importJwtFlow.handlers.handleClientIdSkip}
              onClientSecret={importJwtFlow.handlers.handleClientSecret}
              onBack={importJwtFlow.goBack}
              onClaimsManagerModeChange={importJwtFlow.handlers.handleClaimsManagerModeChange}
            />
          )}

          {importStep === 'confirm' && (
            <ConfirmReview
              fields={[
                { label: 'Name', value: name },
                { label: 'Type', value: 'Import from Bedrock Agents' },
                { label: 'Region', value: importConfig.region },
                { label: 'Bedrock Agent', value: `${importConfig.bedrockAgentName} (${importConfig.bedrockAgentId})` },
                { label: 'Alias', value: `${importConfig.bedrockAliasName} (${importConfig.bedrockAliasId})` },
                {
                  label: 'Framework',
                  value:
                    IMPORT_FRAMEWORK_OPTIONS.find(o => o.id === importConfig.framework)?.title ??
                    importConfig.framework,
                },
                {
                  label: 'Memory',
                  value: MEMORY_OPTIONS.find(o => o.id === importConfig.memory)?.title ?? importConfig.memory,
                },
                ...(importAuthorizerType !== 'AWS_IAM'
                  ? [
                      {
                        label: 'Inbound Auth',
                        value:
                          RUNTIME_AUTHORIZER_TYPE_OPTIONS.find(o => o.id === importAuthorizerType)?.title ??
                          importAuthorizerType,
                      },
                    ]
                  : []),
                ...(importAuthorizerType === 'CUSTOM_JWT' && importJwtConfig
                  ? [{ label: 'Discovery URL', value: importJwtConfig.discoveryUrl }]
                  : []),
              ]}
            />
          )}
        </Panel>
      </Screen>
    );
  }

  // BYO path
  // Disable Screen's exit handler - sub-components handle their own back navigation via handleByoBack
  const byoExitEnabled = false;
  return (
    <Screen
      title="Add Agent"
      onExit={onExit}
      helpText={getHelpText()}
      headerContent={renderStepIndicator()}
      exitEnabled={byoExitEnabled}
    >
      <Panel>
        {byoStep === 'codeLocation' && (
          <CodeLocationInput
            projectRoot={project?.projectRoot ?? process.cwd()}
            initialCodeLocation={byoConfig.codeLocation}
            initialEntrypoint={byoConfig.entrypoint}
            onSubmit={(codeLocation, entrypoint) => {
              setByoConfig(c => ({ ...c, codeLocation, entrypoint }));
              setByoStep('buildType');
              return true;
            }}
            onCancel={handleByoBack}
          />
        )}

        {byoStep === 'buildType' && (
          <WizardSelect title="Select build type" items={buildTypeItems} selectedIndex={buildTypeNav.selectedIndex} />
        )}

        {byoStep === 'dockerfile' && (
          <PathInput
            placeholder="Select a Dockerfile"
            basePath={resolve(project?.projectRoot ?? process.cwd(), byoConfig.codeLocation)}
            pathType="file"
            allowEmpty
            emptyHelpText="Press Enter to use the default Dockerfile"
            onSubmit={value => {
              setByoConfig(c => ({ ...c, dockerfile: value ? basename(value) : '' }));
              goToNextByoStep('dockerfile');
            }}
            onCancel={handleByoBack}
          />
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
              setByoStep('advanced');
            }}
            onSkip={() => setByoStep('advanced')}
            onCancel={handleByoBack}
          />
        )}

        {byoStep === 'advanced' && (
          <WizardMultiSelect
            title="Customize advanced settings"
            description="Select settings to configure. Unselected items use defaults."
            items={byoAdvancedItems}
            cursorIndex={advancedNav.cursorIndex}
            selectedIds={advancedNav.selectedIds}
          />
        )}

        {byoStep === 'networkMode' && (
          <WizardSelect
            title="Select network mode"
            items={networkModeItems}
            selectedIndex={networkModeNav.selectedIndex}
          />
        )}

        {byoStep === 'subnets' && (
          <TextInput
            prompt="Subnet IDs (comma-separated)"
            initialValue={byoConfig.subnets}
            customValidation={validateSubnetIds}
            onSubmit={value => {
              setByoConfig(c => ({ ...c, subnets: value }));
              setByoStep('securityGroups');
            }}
            onCancel={handleByoBack}
          />
        )}

        {byoStep === 'securityGroups' && (
          <TextInput
            prompt="Security group IDs (comma-separated)"
            initialValue={byoConfig.securityGroups}
            customValidation={validateSecurityGroupIds}
            onSubmit={value => {
              setByoConfig(c => ({ ...c, securityGroups: value }));
              goToNextByoStep('securityGroups');
            }}
            onCancel={handleByoBack}
          />
        )}

        {byoStep === 'requestHeaderAllowlist' && (
          <Box flexDirection="column">
            <TextInput
              prompt="Allowed request headers (comma-separated, or press Enter to skip)"
              initialValue={byoConfig.requestHeaderAllowlist}
              allowEmpty
              customValidation={value => {
                const result = validateHeaderAllowlist(value);
                return result.success ? true : result.error!;
              }}
              onSubmit={value => {
                setByoConfig(c => ({ ...c, requestHeaderAllowlist: value }));
                goToNextByoStep('requestHeaderAllowlist');
              }}
              onCancel={handleByoBack}
            />
            <Box marginTop={1}>
              <Text dimColor>
                Enter header names (e.g. Authorization, X-Api-Key, X-Custom-Signature). Bare names without X- prefix are
                auto-prefixed with X-Amzn-Bedrock-AgentCore-Runtime-Custom- for backward compatibility.
              </Text>
            </Box>
          </Box>
        )}

        {byoStep === 'authorizerType' && (
          <WizardSelect
            title="Select inbound auth type"
            description="How will clients authenticate to this agent?"
            items={authorizerTypeItems}
            selectedIndex={authorizerTypeNav.selectedIndex}
          />
        )}

        {byoStep === 'jwtConfig' && (
          <JwtConfigInput
            subStep={byoJwtFlow.subStep}
            steps={byoJwtFlow.steps}
            selectedConstraints={byoJwtFlow.selectedConstraints}
            customClaims={byoJwtFlow.customClaims}
            discoveryUrl={byoJwtFlow.discoveryUrl}
            audience={byoJwtFlow.audience}
            clients={byoJwtFlow.clients}
            scopes={byoJwtFlow.scopes}
            onDiscoveryUrl={byoJwtFlow.handlers.handleDiscoveryUrl}
            onConstraintsPicked={byoJwtFlow.handlers.handleConstraintsPicked}
            onAudience={byoJwtFlow.handlers.handleAudience}
            onClients={byoJwtFlow.handlers.handleClients}
            onScopes={byoJwtFlow.handlers.handleScopes}
            onCustomClaimsDone={byoJwtFlow.handlers.handleCustomClaimsDone}
            onClientId={byoJwtFlow.handlers.handleClientId}
            onClientIdSkip={byoJwtFlow.handlers.handleClientIdSkip}
            onClientSecret={byoJwtFlow.handlers.handleClientSecret}
            onBack={byoJwtFlow.goBack}
            onClaimsManagerModeChange={byoJwtFlow.handlers.handleClaimsManagerModeChange}
          />
        )}

        {byoStep === 'idleTimeout' && (
          <TextInput
            prompt={`Idle session timeout in seconds (${LIFECYCLE_TIMEOUT_MIN}-${LIFECYCLE_TIMEOUT_MAX}, or press Enter to skip)`}
            initialValue=""
            allowEmpty
            customValidation={value => {
              if (!value) return true;
              const n = Number(value);
              if (isNaN(n) || !Number.isInteger(n) || n < LIFECYCLE_TIMEOUT_MIN || n > LIFECYCLE_TIMEOUT_MAX)
                return `Must be an integer between ${LIFECYCLE_TIMEOUT_MIN} and ${LIFECYCLE_TIMEOUT_MAX}`;
              return true;
            }}
            onSubmit={value => {
              setByoConfig(c => ({ ...c, idleTimeout: value }));
              setByoStep('maxLifetime');
            }}
            onCancel={handleByoBack}
          />
        )}

        {byoStep === 'maxLifetime' && (
          <TextInput
            prompt={`Max instance lifetime in seconds (${LIFECYCLE_TIMEOUT_MIN}-${LIFECYCLE_TIMEOUT_MAX}, or press Enter to skip)`}
            initialValue=""
            allowEmpty
            customValidation={value => {
              if (!value) return true;
              const n = Number(value);
              if (isNaN(n) || !Number.isInteger(n) || n < LIFECYCLE_TIMEOUT_MIN || n > LIFECYCLE_TIMEOUT_MAX)
                return `Must be an integer between ${LIFECYCLE_TIMEOUT_MIN} and ${LIFECYCLE_TIMEOUT_MAX}`;
              if (byoConfig.idleTimeout) {
                const idle = Number(byoConfig.idleTimeout);
                if (!isNaN(idle) && n < idle) return 'Must be >= idle timeout';
              }
              return true;
            }}
            onSubmit={value => {
              setByoConfig(c => ({ ...c, maxLifetime: value }));
              goToNextByoStep('maxLifetime');
            }}
            onCancel={handleByoBack}
          />
        )}

        {byoStep === 'sessionStorageMountPath' && (
          <TextInput
            prompt="Session storage mount path (e.g. /mnt/session-storage, or press Enter to skip)"
            initialValue={byoConfig.sessionStorageMountPath}
            allowEmpty
            customValidation={value => {
              if (!value) return true;
              if (!value.startsWith('/')) return 'Must be an absolute path starting with /';
              return true;
            }}
            onSubmit={value => {
              setByoConfig(c => ({ ...c, sessionStorageMountPath: value }));
              goToNextByoStep('sessionStorageMountPath');
            }}
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
              {
                label: 'Build',
                value: BUILD_TYPE_OPTIONS.find(o => o.id === byoConfig.buildType)?.title ?? byoConfig.buildType,
              },
              ...(byoConfig.buildType === 'Container' && byoConfig.dockerfile
                ? [{ label: 'Dockerfile', value: byoConfig.dockerfile }]
                : []),
              {
                label: 'Model Provider',
                value: `${byoConfig.modelProvider} (${DEFAULT_MODEL_IDS[byoConfig.modelProvider]})`,
              },
              ...(byoConfig.modelProvider !== 'Bedrock'
                ? [
                    {
                      label: 'API Key',
                      value: byoConfig.apiKey ? (
                        <Text color="green">Configured</Text>
                      ) : (
                        <Text color="yellow">
                          Not set - fill in{' '}
                          {computeDefaultCredentialEnvVarName(`${projectName}${byoConfig.modelProvider}`)} in .env.local
                        </Text>
                      ),
                    },
                  ]
                : []),
              { label: 'Network Mode', value: byoConfig.networkMode },
              ...(byoConfig.networkMode === 'VPC'
                ? [
                    { label: 'Subnets', value: byoConfig.subnets || '(none)' },
                    { label: 'Security Groups', value: byoConfig.securityGroups || '(none)' },
                  ]
                : []),
              ...(() => {
                const normalizedHeaders = parseAndNormalizeHeaders(byoConfig.requestHeaderAllowlist);
                return normalizedHeaders.length > 0 ? [{ label: 'Headers', value: normalizedHeaders.join(', ') }] : [];
              })(),
              {
                label: 'Inbound Auth',
                value:
                  RUNTIME_AUTHORIZER_TYPE_OPTIONS.find(o => o.id === byoAuthorizerType)?.title ?? byoAuthorizerType,
              },
              ...(byoAuthorizerType === 'CUSTOM_JWT' && byoJwtConfig
                ? [
                    { label: 'Discovery URL', value: byoJwtConfig.discoveryUrl },
                    ...(byoJwtConfig.allowedAudience?.length
                      ? [{ label: 'Allowed Audience', value: byoJwtConfig.allowedAudience.join(', ') }]
                      : []),
                    ...(byoJwtConfig.allowedClients?.length
                      ? [{ label: 'Allowed Clients', value: byoJwtConfig.allowedClients.join(', ') }]
                      : []),
                    ...(byoJwtConfig.allowedScopes?.length
                      ? [{ label: 'Allowed Scopes', value: byoJwtConfig.allowedScopes.join(', ') }]
                      : []),
                    ...(byoJwtConfig.customClaims?.length
                      ? [{ label: 'Custom Claims', value: `${byoJwtConfig.customClaims.length} claim(s) configured` }]
                      : []),
                  ]
                : []),
              ...(byoConfig.idleTimeout ? [{ label: 'Idle Timeout', value: `${byoConfig.idleTimeout}s` }] : []),
              ...(byoConfig.maxLifetime ? [{ label: 'Max Lifetime', value: `${byoConfig.maxLifetime}s` }] : []),
              ...(byoConfig.sessionStorageMountPath
                ? [{ label: 'Session Storage', value: byoConfig.sessionStorageMountPath }]
                : []),
              ...(byoConfig.withConfigBundle
                ? [{ label: 'Config Bundle', value: 'Yes (auto-created on deploy)' }]
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
        <Text dimColor>Set the folder where your agent code will live.</Text>
      </Box>
      <Box>
        <Text dimColor>The folder will be created if it doesn&apos;t exist yet.</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Project: </Text>
        <Text color="blue">{displayPath}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Agent folder (relative to project root):</Text>
        <Box>
          <Text color={activeField === 'codeLocation' ? 'cyan' : 'gray'}>&gt; </Text>
          <Text color={activeField === 'codeLocation' ? undefined : 'gray'}>
            {codeLocation || <Text dimColor>app/my-agent/</Text>}
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
      </Box>
    </Box>
  );
}
