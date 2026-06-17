import type { HarnessModelProvider, RuntimeAuthorizerType } from '../../../../schema';
import {
  HarnessApiFormatSchema,
  MAX_EFS_MOUNTS,
  MAX_S3_MOUNTS,
  NetworkModeSchema,
  SECURITY_GROUP_ID_PATTERN,
  SUBNET_ID_PATTERN,
} from '../../../../schema';
import { HarnessNameSchema, HarnessTruncationStrategySchema } from '../../../../schema/schemas/primitives/harness';
import { ARN_VALIDATION_MESSAGE, isValidArn } from '../../../commands/shared/arn-utils';
import {
  validateBYOMountPath,
  validateEfsAccessPointArn,
  validateS3FilesAccessPointArn,
} from '../../../commands/shared/filesystem-utils';
import { computeManagedOAuthCredentialName } from '../../../primitives/credential-utils';
import {
  ConfirmReview,
  Panel,
  Screen,
  SelectList,
  StepIndicator,
  TextInput,
  WizardMultiSelect,
  WizardSelect,
} from '../../components';
import type { SelectableItem } from '../../components';
import { JwtConfigInput, useJwtConfigFlow } from '../../components/jwt-config';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import { buildMountListItems } from '../agent/buildMountListItems';
import type { AddHarnessConfig, AdvancedSetting, ContainerMode } from './types';
import {
  ADVANCED_SETTING_OPTIONS,
  AUTHORIZER_TYPE_OPTIONS,
  BEDROCK_API_FORMAT_OPTIONS,
  CONTAINER_MODE_OPTIONS,
  GATEWAY_OUTBOUND_AUTH_OPTIONS,
  HARNESS_STEP_LABELS,
  MANAGED_STRATEGY_OPTIONS,
  MEMORY_MODE_OPTIONS,
  MEMORY_OPTIONS,
  MODEL_PROVIDER_OPTIONS,
  NETWORK_MODE_OPTIONS,
  OPENAI_API_FORMAT_OPTIONS,
  SKILL_SOURCE_TYPE_OPTIONS,
  TOOL_SELECT_OPTIONS,
  TRUNCATION_STRATEGY_OPTIONS,
} from './types';
import { useAddHarnessWizard } from './useAddHarnessWizard';
import { isGatedFeaturesEnabled } from '@/cli/feature-flags';
import { Text } from 'ink';
import React, { useEffect, useMemo } from 'react';

/** Inline-validate a comma-separated VPC id list against `pattern` so malformed ids are rejected
 *  at the step (not deferred to a late write/deploy error with a misleading green checkmark). */
function validateIdList(value: string, pattern: RegExp, label: string, example: string): true | string {
  const ids = value
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return `At least one ${label} is required for VPC mode`;
  const invalid = ids.find(id => !pattern.test(id));
  return invalid ? `Invalid ${label} "${invalid}" (expected e.g. ${example})` : true;
}

interface AddHarnessScreenProps {
  existingHarnessNames: string[];
  existingApiKeyCredentialNames?: string[];
  onComplete: (config: AddHarnessConfig) => void;
  onExit: () => void;
}

export function AddHarnessScreen({
  existingHarnessNames,
  existingApiKeyCredentialNames = [],
  onComplete,
  onExit,
}: AddHarnessScreenProps) {
  const wizard = useAddHarnessWizard();

  const jwtFlow = useJwtConfigFlow({
    onComplete: jwtConfig => wizard.setJwtConfig(jwtConfig),
    onBack: () => wizard.goBack(),
    enablePrivateEndpoint: true,
  });

  const modelProviderItems: SelectableItem[] = useMemo(
    () => MODEL_PROVIDER_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const apiFormatItems: SelectableItem[] = useMemo(
    () =>
      (wizard.config.modelProvider === 'open_ai' ? OPENAI_API_FORMAT_OPTIONS : BEDROCK_API_FORMAT_OPTIONS).map(opt => ({
        id: opt.id,
        title: opt.title,
        description: opt.description,
      })),
    [wizard.config.modelProvider]
  );

  const containerModeItems: SelectableItem[] = useMemo(
    () => CONTAINER_MODE_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const advancedSettingItems: SelectableItem[] = useMemo(
    () =>
      ADVANCED_SETTING_OPTIONS
        // Memory-tuning options are mode-scoped: each appears only for the memory mode the user chose,
        // and managed/existing have disjoint knob sets (per the harness API). Disabled shows none.
        //  - memory-managed-tuning  → only when mode === 'managed'  (strategies/event-expiry/KMS)
        //  - memory-existing-tuning → only when mode === 'existing' (actorId/messagesCount/topK/relevance)
        //  - memory-tuning (legacy) → only in the gated-off model, when memory isn't skipped
        .filter(opt => {
          if (opt.id === 'memory-managed-tuning') return wizard.config.memory?.mode === 'managed';
          if (opt.id === 'memory-existing-tuning') return wizard.config.memory?.mode === 'existing';
          if (opt.id === 'memory-tuning') return !wizard.config.memory && wizard.config.skipMemory !== true;
          return true;
        })
        .map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    [wizard.config.skipMemory, wizard.config.memory]
  );

  const toolSelectItems: SelectableItem[] = useMemo(
    () => TOOL_SELECT_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const memoryItems: SelectableItem[] = useMemo(
    () => MEMORY_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const memoryModeItems: SelectableItem[] = useMemo(
    () => MEMORY_MODE_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const managedStrategyItems: SelectableItem[] = useMemo(
    () => MANAGED_STRATEGY_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const networkModeItems: SelectableItem[] = useMemo(
    () => NETWORK_MODE_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const truncationStrategyItems: SelectableItem[] = useMemo(
    () => TRUNCATION_STRATEGY_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const authorizerTypeItems: SelectableItem[] = useMemo(
    () => AUTHORIZER_TYPE_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const gatewayOutboundAuthItems: SelectableItem[] = useMemo(
    () => GATEWAY_OUTBOUND_AUTH_OPTIONS.map(opt => ({ id: opt.id, title: opt.title, description: opt.description })),
    []
  );

  const isNameStep = wizard.step === 'name';
  const isModelProviderStep = wizard.step === 'model-provider';
  const isApiFormatStep = wizard.step === 'api-format';
  const isApiKeyArnStep = wizard.step === 'api-key-arn';
  const isApiBaseStep = wizard.step === 'api-base';
  const isAdditionalParamsStep = wizard.step === 'additional-params';
  const isContainerStep = wizard.step === 'container';
  const isContainerUriStep = wizard.step === 'container-uri';
  const isContainerDockerfileStep = wizard.step === 'container-dockerfile';
  const isAdvancedStep = wizard.step === 'advanced';
  const isToolsSelectStep = wizard.step === 'tools-select';
  const isMcpNameStep = wizard.step === 'mcp-name';
  const isMcpUrlStep = wizard.step === 'mcp-url';
  const isGatewayArnStep = wizard.step === 'gateway-arn';
  const isGatewayOutboundAuthStep = wizard.step === 'gateway-outbound-auth';
  const isGatewayProviderArnStep = wizard.step === 'gateway-provider-arn';
  const isGatewayScopesStep = wizard.step === 'gateway-scopes';
  const isMemoryStep = wizard.step === 'memory';
  const isMemoryModeStep = wizard.step === 'memory-mode';
  const isMemoryStrategiesStep = wizard.step === 'memory-strategies';
  const isMemoryEventExpiryStep = wizard.step === 'memory-event-expiry';
  const isMemoryKmsStep = wizard.step === 'memory-kms';
  const isMemoryExistingRefStep = wizard.step === 'memory-existing-ref';
  const isAuthorizerTypeStep = wizard.step === 'authorizerType';
  const isJwtConfigStep = wizard.step === 'jwtConfig';
  const isNetworkModeStep = wizard.step === 'network-mode';
  const isSubnetsStep = wizard.step === 'subnets';
  const isSecurityGroupsStep = wizard.step === 'security-groups';
  const isIdleTimeoutStep = wizard.step === 'idle-timeout';
  const isMaxLifetimeStep = wizard.step === 'max-lifetime';
  const isMaxIterationsStep = wizard.step === 'max-iterations';
  const isMaxTokensStep = wizard.step === 'max-tokens';
  const isTimeoutStep = wizard.step === 'timeout';
  const isTemperatureStep = wizard.step === 'temperature';
  const isTopPStep = wizard.step === 'top-p';
  const isTopKStep = wizard.step === 'top-k';
  const isModelMaxTokensStep = wizard.step === 'model-max-tokens';
  const isMessagesCountStep = wizard.step === 'memory-messages-count';
  const isMemoryRetrievalTopKStep = wizard.step === 'memory-retrieval-top-k';
  const isMemoryRelevanceScoreStep = wizard.step === 'memory-relevance-score';
  const isMcpHeadersStep = wizard.step === 'mcp-headers';
  const isAllowedToolsStep = wizard.step === 'allowed-tools';
  const isTruncationStrategyStep = wizard.step === 'truncation-strategy';
  const isSessionStoragePathStep = wizard.step === 'session-storage-path';
  const isEfsArnStep = wizard.step === 'efs-arn';
  const isEfsMountPathStep = wizard.step === 'efs-mount-path';
  const isEfsAddAnotherStep = wizard.step === 'efs-add-another';
  const isS3ArnStep = wizard.step === 's3-arn';
  const isS3MountPathStep = wizard.step === 's3-mount-path';
  const isS3AddAnotherStep = wizard.step === 's3-add-another';
  const isSkillsSourceTypeStep = wizard.step === 'skills-source-type';
  const isSkillPathStep = wizard.step === 'skill-path';
  const isSkillS3UriStep = wizard.step === 'skill-s3-uri';
  const isSkillGitUrlStep = wizard.step === 'skill-git-url';
  const isSkillGitPathStep = wizard.step === 'skill-git-path';
  const isSkillGitCredentialStep = wizard.step === 'skill-git-credential';
  const isSkillGitUsernameStep = wizard.step === 'skill-git-username';
  const isSkillAddAnotherStep = wizard.step === 'skill-add-another';
  const isConfirmStep = wizard.step === 'confirm';

  const modelProviderNav = useListNavigation({
    items: modelProviderItems,
    onSelect: item => wizard.setModelProvider(item.id as HarnessModelProvider),
    onExit: () => wizard.goBack(),
    isActive: isModelProviderStep,
  });

  const apiFormatNav = useListNavigation({
    items: apiFormatItems,
    onSelect: item => wizard.setApiFormat(HarnessApiFormatSchema.parse(item.id)),
    onExit: () => wizard.goBack(),
    isActive: isApiFormatStep,
  });

  const containerModeNav = useListNavigation({
    items: containerModeItems,
    onSelect: item => wizard.setContainerMode(item.id as ContainerMode),
    onExit: () => wizard.goBack(),
    isActive: isContainerStep,
  });

  const advancedSettingsNav = useMultiSelectNavigation({
    items: advancedSettingItems,
    getId: item => item.id,
    onConfirm: ids => wizard.setAdvancedSettings(ids as AdvancedSetting[]),
    onExit: () => wizard.goBack(),
    isActive: isAdvancedStep,
    requireSelection: false,
  });

  const toolsSelectNav = useMultiSelectNavigation({
    items: toolSelectItems,
    getId: item => item.id,
    onConfirm: ids => wizard.setSelectedTools(ids),
    onExit: () => wizard.goBack(),
    isActive: isToolsSelectStep,
    requireSelection: false,
  });

  const memoryNav = useListNavigation({
    items: memoryItems,
    onSelect: item => wizard.setMemoryEnabled(item.id === 'enabled'),
    onExit: () => wizard.goBack(),
    isActive: isMemoryStep,
  });

  const memoryModeNav = useListNavigation({
    items: memoryModeItems,
    onSelect: item => wizard.setMemoryMode(item.id as 'managed' | 'existing' | 'disabled'),
    onExit: () => wizard.goBack(),
    isActive: isMemoryModeStep,
  });

  const initialStrategyIds = useMemo(
    () => (wizard.config.memory?.mode === 'managed' ? (wizard.config.memory.strategies ?? []) : []),
    // Seed once from the current config; per-keystroke selection is owned by the nav hook thereafter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const managedStrategyNav = useMultiSelectNavigation({
    items: managedStrategyItems,
    getId: item => item.id,
    initialSelectedIds: initialStrategyIds,
    onConfirm: ids => wizard.setMemoryStrategies(ids),
    onExit: () => wizard.goBack(),
    isActive: isMemoryStrategiesStep,
    // Optional: confirming with nothing selected leaves strategies absent → service default.
    requireSelection: false,
  });

  const authorizerTypeNav = useListNavigation({
    items: authorizerTypeItems,
    onSelect: item => wizard.setAuthorizerType(item.id as RuntimeAuthorizerType),
    onExit: () => wizard.goBack(),
    isActive: isAuthorizerTypeStep,
  });

  const gatewayOutboundAuthNav = useListNavigation({
    items: gatewayOutboundAuthItems,
    onSelect: item => wizard.setGatewayOutboundAuth(item.id as 'awsIam' | 'none' | 'oauth'),
    onExit: () => wizard.goBack(),
    isActive: isGatewayOutboundAuthStep,
  });

  const networkModeNav = useListNavigation({
    items: networkModeItems,
    onSelect: item => wizard.setNetworkMode(NetworkModeSchema.parse(item.id)),
    onExit: () => wizard.goBack(),
    isActive: isNetworkModeStep,
  });

  const truncationStrategyNav = useListNavigation({
    items: truncationStrategyItems,
    onSelect: item => wizard.setTruncationStrategy(HarnessTruncationStrategySchema.parse(item.id)),
    onExit: () => wizard.goBack(),
    isActive: isTruncationStrategyStep,
  });

  const skillSourceTypeItems: SelectableItem[] = useMemo(
    () =>
      SKILL_SOURCE_TYPE_OPTIONS.map(opt => ({
        id: opt.id,
        title: opt.title,
        description: opt.id === 'aws_skills' && !isGatedFeaturesEnabled() ? 'Coming soon' : opt.description,
        disabled: opt.id === 'aws_skills' && !isGatedFeaturesEnabled(),
      })),
    []
  );

  const skillSourceTypeNav = useListNavigation({
    items: skillSourceTypeItems,
    onSelect: item => wizard.setSkillSourceType(item.id as 'path' | 's3' | 'git' | 'aws_skills'),
    onExit: () => wizard.goBack(),
    isActive: isSkillsSourceTypeStep,
    isDisabled: item => item.disabled === true,
  });

  const skillGitCredentialItems: SelectableItem[] = useMemo(
    () => [
      ...existingApiKeyCredentialNames.map(name => ({
        id: name,
        title: name,
        description: 'Use existing API key credential',
      })),
      { id: 'skip', title: 'Skip (no auth needed)', description: 'Repository is publicly accessible' },
    ],
    [existingApiKeyCredentialNames]
  );

  const skillGitCredentialNav = useListNavigation({
    items: skillGitCredentialItems,
    onSelect: item => {
      wizard.submitSkillGitCredential(item.id);
    },
    onExit: () => wizard.goBack(),
    isActive: isSkillGitCredentialStep,
  });

  useEffect(() => {
    if (isSkillGitCredentialStep && existingApiKeyCredentialNames.length === 0) {
      wizard.submitSkillGitCredential('skip');
    }
  }, [isSkillGitCredentialStep, existingApiKeyCredentialNames.length]);

  const skillAddAnotherItems: SelectableItem[] = useMemo(
    () => [
      { id: 'add', title: 'Add another skill', description: 'Add one more skill source' },
      { id: 'done', title: 'Done', description: `${(wizard.config.skills ?? []).length} skill(s) configured` },
    ],
    [wizard.config.skills]
  );

  const skillAddAnotherNav = useListNavigation({
    items: skillAddAnotherItems,
    onSelect: item => wizard.submitSkillAddAnother(item.id),
    onExit: () => wizard.goBack(),
    isActive: isSkillAddAnotherStep,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const helpText = isJwtConfigStep
    ? jwtFlow.subStep === 'constraintPicker'
      ? HELP_TEXT.MULTI_SELECT
      : jwtFlow.subStep === 'privateEndpointType' || jwtFlow.subStep === 'vpcIpType'
        ? HELP_TEXT.NAVIGATE_SELECT
        : jwtFlow.subStep === 'customClaims'
          ? jwtFlow.claimsManagerMode === 'add' || jwtFlow.claimsManagerMode === 'edit'
            ? '↑/↓ field · ←/→ cycle · Enter next/save · Esc cancel'
            : 'Navigate · Enter select · Esc back'
          : jwtFlow.subStep === 'domainOverrides'
            ? jwtFlow.overridesManagerMode === 'add' || jwtFlow.overridesManagerMode === 'edit'
              ? HELP_TEXT.TEXT_INPUT
              : 'Navigate · Enter select · Esc back'
            : HELP_TEXT.TEXT_INPUT
    : isAdvancedStep || isToolsSelectStep || isMemoryStrategiesStep
      ? 'Space toggle · Enter confirm · Esc back'
      : isModelProviderStep ||
          isApiFormatStep ||
          isMemoryStep ||
          isMemoryModeStep ||
          isContainerStep ||
          isNetworkModeStep ||
          isTruncationStrategyStep ||
          isAuthorizerTypeStep ||
          isGatewayOutboundAuthStep ||
          isSkillsSourceTypeStep ||
          isSkillGitCredentialStep ||
          isSkillAddAnotherStep
        ? HELP_TEXT.NAVIGATE_SELECT
        : isConfirmStep
          ? HELP_TEXT.CONFIRM_CANCEL
          : HELP_TEXT.TEXT_INPUT;

  const headerContent = <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={HARNESS_STEP_LABELS} />;

  const confirmFields = useMemo(() => {
    const fields = [
      { label: 'Name', value: wizard.config.name },
      { label: 'Model Provider', value: wizard.config.modelProvider },
      { label: 'Model ID', value: wizard.config.modelId },
    ];

    if (wizard.config.apiFormat) {
      fields.push({ label: 'API Format', value: wizard.config.apiFormat });
    }

    if (wizard.config.apiKeyArn) {
      fields.push({ label: 'API Key ARN', value: wizard.config.apiKeyArn });
    }

    if (wizard.config.apiBase) {
      fields.push({ label: 'API Base URL', value: wizard.config.apiBase });
    }

    if (wizard.config.additionalParams) {
      fields.push({ label: 'Additional Params', value: JSON.stringify(wizard.config.additionalParams) });
    }

    const mem = wizard.config.memory;
    if (mem) {
      // Mode-tagged memory (gated ON).
      if (mem.mode === 'managed') {
        const titled = mem.strategies?.length
          ? mem.strategies.map(s => s.charAt(0) + s.slice(1).toLowerCase().replace('_', ' ')).join(', ')
          : 'default strategies';
        fields.push({ label: 'Memory', value: `Managed (${titled})` });
        if (mem.eventExpiryDuration !== undefined) {
          fields.push({ label: 'Memory Event Expiry', value: `${mem.eventExpiryDuration} days` });
        }
        if (mem.encryptionKeyArn) {
          fields.push({ label: 'Memory KMS Key', value: mem.encryptionKeyArn });
        }
      } else if (mem.mode === 'existing') {
        fields.push({ label: 'Memory', value: `Existing (${mem.arn ?? mem.name ?? '—'})` });
      } else {
        fields.push({ label: 'Memory', value: 'Disabled' });
      }
    } else if (wizard.config.skipMemory !== undefined) {
      // Legacy enabled/disabled (gated OFF).
      fields.push({ label: 'Memory', value: wizard.config.skipMemory ? 'Disabled' : 'Enabled' });
    }

    if (wizard.config.messagesCount !== undefined) {
      fields.push({ label: 'Memory Messages Count', value: String(wizard.config.messagesCount) });
    }
    if (wizard.config.memoryTopK !== undefined) {
      fields.push({ label: 'Memory Retrieval Top K', value: String(wizard.config.memoryTopK) });
    }
    if (wizard.config.memoryRelevanceScore !== undefined) {
      fields.push({ label: 'Memory Relevance Score', value: String(wizard.config.memoryRelevanceScore) });
    }

    if (wizard.config.allowedTools?.length) {
      fields.push({ label: 'Allowed Tools', value: wizard.config.allowedTools.join(', ') });
    }

    if (wizard.config.authorizerType) {
      fields.push({
        label: 'Auth Type',
        value:
          AUTHORIZER_TYPE_OPTIONS.find(o => o.id === wizard.config.authorizerType)?.title ??
          wizard.config.authorizerType,
      });
    }
    if (wizard.config.authorizerType === 'CUSTOM_JWT' && wizard.config.jwtConfig) {
      fields.push({ label: 'Discovery URL', value: wizard.config.jwtConfig.discoveryUrl });
      if (wizard.config.jwtConfig.allowedAudience?.length) {
        fields.push({ label: 'Allowed Audience', value: wizard.config.jwtConfig.allowedAudience.join(', ') });
      }
      if (wizard.config.jwtConfig.allowedClients?.length) {
        fields.push({ label: 'Allowed Clients', value: wizard.config.jwtConfig.allowedClients.join(', ') });
      }
      if (wizard.config.jwtConfig.allowedScopes?.length) {
        fields.push({ label: 'Allowed Scopes', value: wizard.config.jwtConfig.allowedScopes.join(', ') });
      }
      if (wizard.config.jwtConfig.customClaims?.length) {
        fields.push({
          label: 'Custom Claims',
          value: `${wizard.config.jwtConfig.customClaims.length} claim(s) configured`,
        });
      }
      const pe = wizard.config.jwtConfig.privateEndpoint;
      if (pe?.selfManagedLatticeResource) {
        fields.push({
          label: 'Private Endpoint',
          value: `VPC Lattice (${pe.selfManagedLatticeResource.resourceConfigurationIdentifier})`,
        });
      } else if (pe?.managedVpcResource) {
        const v = pe.managedVpcResource;
        fields.push({
          label: 'Private Endpoint',
          value: `Managed VPC ${v.vpcIdentifier} · ${v.subnetIds.length} subnet(s) · ${v.endpointIpAddressType}`,
        });
      }
      if (wizard.config.jwtConfig.privateEndpointOverrides?.length) {
        fields.push({
          label: 'Domain Overrides',
          value: `${wizard.config.jwtConfig.privateEndpointOverrides.length} per-domain override(s)`,
        });
      }
      if (wizard.config.jwtConfig.clientId) {
        fields.push({ label: 'Harness Credential', value: computeManagedOAuthCredentialName(wizard.config.name) });
      }
    }

    if (wizard.config.selectedTools?.length) {
      const toolLabels = wizard.config.selectedTools.map(id => TOOL_SELECT_OPTIONS.find(o => o.id === id)?.title ?? id);
      fields.push({ label: 'Tools', value: toolLabels.join(', ') });
      if (wizard.config.mcpName) {
        fields.push({ label: 'MCP Server', value: `${wizard.config.mcpName} (${wizard.config.mcpUrl})` });
      }
      if (wizard.config.mcpHeaders && Object.keys(wizard.config.mcpHeaders).length > 0) {
        fields.push({ label: 'MCP Headers', value: JSON.stringify(wizard.config.mcpHeaders) });
      }
      if (wizard.config.gatewayArn) {
        fields.push({ label: 'Gateway ARN', value: wizard.config.gatewayArn });
      }
      if (wizard.config.gatewayOutboundAuth) {
        fields.push({
          label: 'Gateway Auth',
          value:
            GATEWAY_OUTBOUND_AUTH_OPTIONS.find(o => o.id === wizard.config.gatewayOutboundAuth)?.title ??
            wizard.config.gatewayOutboundAuth,
        });
      }
      if (wizard.config.gatewayOutboundAuth === 'oauth') {
        if (wizard.config.gatewayProviderArn) {
          fields.push({ label: 'Provider ARN', value: wizard.config.gatewayProviderArn });
        }
        if (wizard.config.gatewayScopes) {
          fields.push({ label: 'OAuth Scopes', value: wizard.config.gatewayScopes });
        }
      }
    }

    if (wizard.config.skills?.length) {
      for (const [i, skill] of wizard.config.skills.entries()) {
        const label = skill.s3Uri ?? skill.gitUrl ?? skill.path ?? 'unknown';
        fields.push({ label: `Skill ${i + 1}`, value: label });
      }
    }

    if (wizard.config.containerUri) {
      fields.push({ label: 'Container URI', value: wizard.config.containerUri });
    }

    if (wizard.config.dockerfilePath) {
      fields.push({ label: 'Dockerfile', value: wizard.config.dockerfilePath });
    }

    if (wizard.config.networkMode) {
      fields.push({ label: 'Network Mode', value: wizard.config.networkMode });
      if (wizard.config.networkMode === 'VPC') {
        if (wizard.config.subnets) {
          fields.push({ label: 'Subnets', value: wizard.config.subnets.join(', ') });
        }
        if (wizard.config.securityGroups) {
          fields.push({ label: 'Security Groups', value: wizard.config.securityGroups.join(', ') });
        }
      }
    }

    if (wizard.config.idleTimeout !== undefined) {
      fields.push({ label: 'Idle Timeout', value: `${wizard.config.idleTimeout}s` });
    }

    if (wizard.config.maxLifetime !== undefined) {
      fields.push({ label: 'Max Lifetime', value: `${wizard.config.maxLifetime}s` });
    }

    if (wizard.config.maxIterations !== undefined) {
      fields.push({ label: 'Max Iterations', value: String(wizard.config.maxIterations) });
    }

    if (wizard.config.maxTokens !== undefined) {
      fields.push({ label: 'Max Tokens', value: String(wizard.config.maxTokens) });
    }

    if (wizard.config.timeoutSeconds !== undefined) {
      fields.push({ label: 'Timeout', value: `${wizard.config.timeoutSeconds}s` });
    }

    if (wizard.config.temperature !== undefined) {
      fields.push({ label: 'Temperature', value: String(wizard.config.temperature) });
    }
    if (wizard.config.topP !== undefined) {
      fields.push({ label: 'Top P', value: String(wizard.config.topP) });
    }
    if (wizard.config.topK !== undefined) {
      fields.push({ label: 'Top K', value: String(wizard.config.topK) });
    }
    if (wizard.config.modelMaxTokens !== undefined) {
      fields.push({ label: 'Model Max Tokens', value: String(wizard.config.modelMaxTokens) });
    }

    if (wizard.config.truncationStrategy) {
      fields.push({ label: 'Truncation Strategy', value: wizard.config.truncationStrategy });
    }

    if (wizard.config.sessionStoragePath) {
      fields.push({ label: 'Session Storage', value: wizard.config.sessionStoragePath });
    }

    for (const [i, m] of (wizard.config.efsAccessPoints ?? []).entries()) {
      fields.push({ label: `EFS Mount ${i + 1}`, value: `${m.accessPointArn.slice(-20)} → ${m.mountPath}` });
    }

    for (const [i, m] of (wizard.config.s3AccessPoints ?? []).entries()) {
      fields.push({ label: `S3 Files Mount ${i + 1}`, value: `${m.accessPointArn.slice(-20)} → ${m.mountPath}` });
    }

    return fields;
  }, [wizard.config]);

  const efsAddAnotherItems = useMemo(
    () => buildMountListItems(wizard.config.efsAccessPoints ?? [], 'EFS', MAX_EFS_MOUNTS),
    [wizard.config.efsAccessPoints]
  );

  const efsAddAnotherNav = useListNavigation({
    items: efsAddAnotherItems,
    onSelect: item => wizard.submitEfsAddAnother(item.id),
    onExit: () => wizard.goBack(),
    isActive: isEfsAddAnotherStep,
  });

  const s3AddAnotherItems = useMemo(
    () => buildMountListItems(wizard.config.s3AccessPoints ?? [], 'S3 Files', MAX_S3_MOUNTS),
    [wizard.config.s3AccessPoints]
  );

  const s3AddAnotherNav = useListNavigation({
    items: s3AddAnotherItems,
    onSelect: item => wizard.submitS3AddAnother(item.id),
    onExit: () => wizard.goBack(),
    isActive: isS3AddAnotherStep,
  });

  return (
    <Screen
      title="Add Harness"
      onExit={onExit}
      helpText={helpText}
      headerContent={headerContent}
      exitEnabled={isNameStep}
    >
      <Panel>
        {isNameStep && (
          <TextInput
            key="name"
            prompt="Harness name"
            initialValue={generateUniqueName('MyHarness', existingHarnessNames)}
            onSubmit={wizard.setName}
            onCancel={onExit}
            schema={HarnessNameSchema}
            customValidation={value => !existingHarnessNames.includes(value) || 'Harness name already exists'}
          />
        )}

        {isModelProviderStep && (
          <WizardSelect
            title="Select model provider"
            description="Choose where to run your models"
            items={modelProviderItems}
            selectedIndex={modelProviderNav.selectedIndex}
          />
        )}

        {isApiFormatStep && (
          <WizardSelect
            title="Select API format"
            description={
              wizard.config.modelProvider === 'open_ai'
                ? 'Choose the API format for OpenAI model invocation'
                : 'Choose the API format for model invocation (Responses and ChatCompletions use Bedrock Mantle)'
            }
            items={apiFormatItems}
            selectedIndex={apiFormatNav.selectedIndex}
          />
        )}

        {isApiKeyArnStep && (
          <TextInput
            key="api-key-arn"
            prompt={
              wizard.config.modelProvider === 'lite_llm'
                ? 'API Key ARN (AgentCore Identity, optional — leave blank to skip)'
                : 'API Key ARN (AgentCore Identity)'
            }
            initialValue=""
            // LiteLLM's key is optional — let an empty value through to skip it.
            allowEmpty={wizard.config.modelProvider === 'lite_llm'}
            onSubmit={wizard.setApiKeyArn}
            onCancel={() => wizard.goBack()}
            customValidation={value =>
              // LiteLLM's key is optional — allow an empty value to skip it.
              (wizard.config.modelProvider === 'lite_llm' && value.trim().length === 0) ||
              isValidArn(value) ||
              ARN_VALIDATION_MESSAGE
            }
          />
        )}

        {isApiBaseStep && (
          <TextInput
            key="api-base"
            prompt="API base URL (optional — leave blank to use the provider default)"
            initialValue=""
            allowEmpty
            onSubmit={wizard.setApiBase}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isAdditionalParamsStep && (
          <TextInput
            key="additional-params"
            prompt='Additional params as a JSON object (optional, e.g. {"reasoning_effort":"high"})'
            initialValue=""
            allowEmpty
            onSubmit={value => {
              const trimmed = value.trim();
              if (trimmed.length === 0) {
                wizard.setAdditionalParams(undefined);
                return;
              }
              wizard.setAdditionalParams(JSON.parse(trimmed) as Record<string, unknown>);
            }}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              const trimmed = value.trim();
              if (trimmed.length === 0) return true;
              try {
                const parsed = JSON.parse(trimmed) as unknown;
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                  return 'Additional params must be a JSON object';
                }
                return true;
              } catch {
                return 'Additional params must be valid JSON';
              }
            }}
          />
        )}

        {isContainerStep && (
          <WizardSelect
            title="Custom environment"
            description="Optionally provide a custom container image for the harness runtime"
            items={containerModeItems}
            selectedIndex={containerModeNav.selectedIndex}
          />
        )}

        {isContainerUriStep && (
          <TextInput
            key="container-uri"
            // eslint-disable-next-line partition/no-hardcoded-endpoint-tld -- example placeholder, not a real endpoint
            prompt="Container image URI (e.g., 123456789012.dkr.ecr.us-east-1.amazonaws.com/my-harness:latest)"
            initialValue=""
            onSubmit={wizard.setContainerUri}
            onCancel={() => wizard.goBack()}
            customValidation={value => (value.trim().length > 0 ? true : 'Container URI is required')}
          />
        )}

        {isContainerDockerfileStep && (
          <TextInput
            key="container-dockerfile"
            prompt="Path to Dockerfile"
            initialValue=""
            onSubmit={wizard.setDockerfilePath}
            onCancel={() => wizard.goBack()}
            customValidation={value => (value.trim().length > 0 ? true : 'Dockerfile path is required')}
          />
        )}

        {isAdvancedStep && (
          <WizardMultiSelect
            title="Advanced settings (optional)"
            description="Configure tools, network, lifecycle, execution limits, truncation, or session storage"
            items={advancedSettingItems}
            cursorIndex={advancedSettingsNav.cursorIndex}
            selectedIds={advancedSettingsNav.selectedIds}
          />
        )}

        {isToolsSelectStep && (
          <WizardMultiSelect
            title="Select tools for your harness"
            description="Choose built-in tools, MCP servers, or gateways"
            items={toolSelectItems}
            cursorIndex={toolsSelectNav.cursorIndex}
            selectedIds={toolsSelectNav.selectedIds}
          />
        )}

        {isMcpNameStep && (
          <TextInput
            key="mcp-name"
            prompt="MCP server name"
            initialValue=""
            onSubmit={wizard.setMcpName}
            onCancel={() => wizard.goBack()}
            customValidation={value => (value.trim().length > 0 ? true : 'MCP name is required')}
          />
        )}

        {isMcpUrlStep && (
          <TextInput
            key="mcp-url"
            prompt="MCP server URL"
            initialValue=""
            onSubmit={wizard.setMcpUrl}
            onCancel={() => wizard.goBack()}
            customValidation={value =>
              value.startsWith('http://') || value.startsWith('https://') ? true : 'Must be a valid URL'
            }
          />
        )}

        {isMcpHeadersStep && (
          <TextInput
            key="mcp-headers"
            prompt='MCP request headers as a JSON object (optional, e.g. {"X-Api-Key":"abc"})'
            description="Headers sent on every request to the MCP server"
            initialValue=""
            allowEmpty
            onSubmit={value => {
              const trimmed = value.trim();
              if (trimmed.length === 0) {
                wizard.setMcpHeaders(undefined);
                return;
              }
              wizard.setMcpHeaders(JSON.parse(trimmed) as Record<string, string>);
            }}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              const trimmed = value.trim();
              if (trimmed.length === 0) return true;
              try {
                const parsed = JSON.parse(trimmed) as unknown;
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                  return 'Headers must be a JSON object';
                }
                for (const [k, v] of Object.entries(parsed)) {
                  if (typeof v !== 'string') return `Header "${k}" value must be a string`;
                }
                return true;
              } catch {
                return 'Headers must be valid JSON';
              }
            }}
          />
        )}

        {isGatewayArnStep && (
          <TextInput
            key="gateway-arn"
            prompt="Gateway ARN"
            initialValue=""
            onSubmit={wizard.setGatewayArn}
            onCancel={() => wizard.goBack()}
            customValidation={value => (isValidArn(value) ? true : ARN_VALIDATION_MESSAGE)}
          />
        )}

        {isGatewayOutboundAuthStep && (
          <WizardSelect
            title="Gateway outbound auth"
            description="How should the harness authenticate when calling the gateway?"
            items={gatewayOutboundAuthItems}
            selectedIndex={gatewayOutboundAuthNav.selectedIndex}
          />
        )}

        {isGatewayProviderArnStep && (
          <TextInput
            key="gateway-provider-arn"
            prompt="Credential provider ARN"
            description="ARN of the AgentCore Identity OAuth2 credential provider"
            initialValue=""
            onSubmit={wizard.setGatewayProviderArn}
            onCancel={() => wizard.goBack()}
            customValidation={value => (isValidArn(value) ? true : ARN_VALIDATION_MESSAGE)}
          />
        )}

        {isGatewayScopesStep && (
          <TextInput
            key="gateway-scopes"
            prompt="OAuth scopes (comma-separated)"
            description="Scopes requested from the credential provider"
            initialValue=""
            onSubmit={wizard.setGatewayScopes}
            onCancel={() => wizard.goBack()}
            customValidation={value => (value.trim().length > 0 ? true : 'At least one scope is required')}
          />
        )}

        {isSkillsSourceTypeStep && (
          <WizardSelect
            title="Skill source type"
            description="Where is your skill located?"
            items={skillSourceTypeItems}
            selectedIndex={skillSourceTypeNav.selectedIndex}
          />
        )}

        {isSkillPathStep && (
          <TextInput
            key="skill-path"
            prompt="Path to an installed skill in the environment"
            initialValue=""
            onSubmit={wizard.submitSkillPath}
            onCancel={() => wizard.goBack()}
            customValidation={value => (value.trim().length > 0 ? true : 'Path is required')}
          />
        )}

        {isSkillS3UriStep && (
          <TextInput
            key="skill-s3-uri"
            prompt="S3 URI (e.g., s3://my-bucket/skills/research)"
            initialValue=""
            onSubmit={wizard.submitSkillS3}
            onCancel={() => wizard.goBack()}
            customValidation={value => (value.startsWith('s3://') ? true : 'Must start with s3://')}
          />
        )}

        {isSkillGitUrlStep && (
          <TextInput
            key="skill-git-url"
            prompt="Git repository URL (HTTPS)"
            initialValue=""
            onSubmit={wizard.submitSkillGitUrl}
            onCancel={() => wizard.goBack()}
            customValidation={value => (value.startsWith('https://') ? true : 'Must be an HTTPS URL')}
          />
        )}

        {isSkillGitPathStep && (
          <TextInput
            key="skill-git-path"
            prompt="Subdirectory path within the repo (optional, press Enter to skip)"
            initialValue=""
            allowEmpty
            onSubmit={wizard.submitSkillGitPath}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isSkillGitCredentialStep && (
          <WizardSelect
            title="Git authentication"
            description="Select a credential for private repository access"
            items={skillGitCredentialItems}
            selectedIndex={skillGitCredentialNav.selectedIndex}
          />
        )}

        {isSkillGitUsernameStep && (
          <TextInput
            key="skill-git-username"
            prompt="Username for git auth (optional, press Enter to skip)"
            initialValue=""
            allowEmpty
            onSubmit={wizard.submitSkillGitUsername}
            onCancel={() => wizard.goBack()}
          />
        )}

        {wizard.step === 'skill-aws-skills-paths' && (
          <TextInput
            key="skill-aws-skills-paths"
            prompt="Filter paths (comma-separated globs, e.g., core-skills/* or specialized-skills/operations-skills/*) or leave blank for all. See https://github.com/aws/agent-toolkit-for-aws/tree/main/skills"
            initialValue=""
            allowEmpty
            onSubmit={wizard.submitSkillAwsSkillsPaths}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isSkillAddAnotherStep && (
          <WizardSelect
            title="Add another skill?"
            description={`${(wizard.config.skills ?? []).length} skill(s) configured`}
            items={skillAddAnotherItems}
            selectedIndex={skillAddAnotherNav.selectedIndex}
          />
        )}

        {isMemoryStep && (
          <WizardSelect
            title="Memory"
            description="Persistent memory lets the harness remember context across sessions"
            items={memoryItems}
            selectedIndex={memoryNav.selectedIndex}
          />
        )}

        {isMemoryModeStep && (
          <WizardSelect
            title="Memory"
            description="How should this harness handle memory?"
            items={memoryModeItems}
            selectedIndex={memoryModeNav.selectedIndex}
          />
        )}

        {isMemoryStrategiesStep && (
          <WizardMultiSelect
            title="Memory strategies (optional)"
            description="Strategies to enable. Leave all unselected to use the service default."
            items={managedStrategyItems}
            cursorIndex={managedStrategyNav.cursorIndex}
            selectedIds={managedStrategyNav.selectedIds}
          />
        )}

        {isMemoryEventExpiryStep && (
          <TextInput
            key="memory-event-expiry"
            prompt="Memory event expiry (days)"
            description="Event retention in days (3-365); press Enter for the default (30)"
            initialValue=""
            allowEmpty
            onSubmit={wizard.setMemoryEventExpiry}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              if (value.trim() === '') return true;
              const num = parseInt(value, 10);
              return !isNaN(num) && num >= 3 && num <= 365 ? true : 'Must be an integer between 3 and 365';
            }}
          />
        )}

        {isMemoryKmsStep && (
          <TextInput
            key="memory-kms"
            prompt="Memory KMS key ARN (optional)"
            description="Customer-managed KMS key for memory encryption; press Enter to use the AWS-owned key"
            initialValue=""
            allowEmpty
            onSubmit={wizard.setMemoryKms}
            onCancel={() => wizard.goBack()}
            customValidation={value =>
              value.trim() === '' || isValidArn(value.trim()) ? true : ARN_VALIDATION_MESSAGE
            }
          />
        )}

        {isMemoryExistingRefStep && (
          <TextInput
            key="memory-existing-ref"
            prompt="Existing memory (name or ARN)"
            description="A project memory name, or a memory ARN to reference"
            initialValue=""
            onSubmit={wizard.setMemoryExistingRef}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              const v = value.trim();
              if (v === '') return 'A memory name or ARN is required';
              if (v.startsWith('arn:') && !isValidArn(v)) return ARN_VALIDATION_MESSAGE;
              return true;
            }}
          />
        )}

        {isAuthorizerTypeStep && (
          <WizardSelect
            title="Authorizer type"
            description="How will clients authenticate to this harness?"
            items={authorizerTypeItems}
            selectedIndex={authorizerTypeNav.selectedIndex}
          />
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
            latticeResourceId={jwtFlow.latticeResourceId}
            vpcId={jwtFlow.vpcId}
            vpcSubnets={jwtFlow.vpcSubnets}
            vpcSecurityGroups={jwtFlow.vpcSecurityGroups}
            vpcRoutingDomain={jwtFlow.vpcRoutingDomain}
            onDiscoveryUrl={jwtFlow.handlers.handleDiscoveryUrl}
            onConstraintsPicked={jwtFlow.handlers.handleConstraintsPicked}
            onAudience={jwtFlow.handlers.handleAudience}
            onClients={jwtFlow.handlers.handleClients}
            onScopes={jwtFlow.handlers.handleScopes}
            onCustomClaimsDone={jwtFlow.handlers.handleCustomClaimsDone}
            onPrivateEndpointType={jwtFlow.handlers.handlePrivateEndpointType}
            onLatticeResourceId={jwtFlow.handlers.handleLatticeResourceId}
            onVpcId={jwtFlow.handlers.handleVpcId}
            onVpcSubnets={jwtFlow.handlers.handleVpcSubnets}
            onVpcIpType={jwtFlow.handlers.handleVpcIpType}
            onVpcSecurityGroups={jwtFlow.handlers.handleVpcSecurityGroups}
            onVpcRoutingDomain={jwtFlow.handlers.handleVpcRoutingDomain}
            domainOverrides={jwtFlow.domainOverrides}
            onDomainOverridesDone={jwtFlow.handlers.handleDomainOverridesDone}
            onOverridesManagerModeChange={jwtFlow.handlers.handleOverridesManagerModeChange}
            onClientId={jwtFlow.handlers.handleClientId}
            onClientIdSkip={jwtFlow.handlers.handleClientIdSkip}
            onClientSecret={jwtFlow.handlers.handleClientSecret}
            onBack={jwtFlow.goBack}
            onClaimsManagerModeChange={jwtFlow.handlers.handleClaimsManagerModeChange}
          />
        )}

        {isNetworkModeStep && (
          <WizardSelect
            title="Network mode"
            description="Choose network deployment mode"
            items={networkModeItems}
            selectedIndex={networkModeNav.selectedIndex}
          />
        )}

        {isSubnetsStep && (
          <TextInput
            key="subnets"
            prompt="Subnet IDs (comma-separated)"
            description="VPC subnet IDs where the harness will be deployed"
            initialValue=""
            onSubmit={wizard.setSubnets}
            onCancel={() => wizard.goBack()}
            customValidation={value => validateIdList(value, SUBNET_ID_PATTERN, 'subnet', 'subnet-0abc123def456')}
          />
        )}

        {isSecurityGroupsStep && (
          <TextInput
            key="security-groups"
            prompt="Security Group IDs (comma-separated)"
            description="Security groups to attach to the harness network interface"
            initialValue=""
            onSubmit={wizard.setSecurityGroups}
            onCancel={() => wizard.goBack()}
            customValidation={value =>
              validateIdList(value, SECURITY_GROUP_ID_PATTERN, 'security group', 'sg-0abc123def456')
            }
          />
        )}

        {isIdleTimeoutStep && (
          <TextInput
            key="idle-timeout"
            prompt="Idle timeout (seconds)"
            description="Time before an inactive session is stopped (60-28800, default 900)"
            initialValue="900"
            onSubmit={wizard.setIdleTimeout}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              const num = parseInt(value, 10);
              return !isNaN(num) && num >= 60 && num <= 28800 ? true : 'Must be between 60 and 28800';
            }}
          />
        )}

        {isMaxLifetimeStep && (
          <TextInput
            key="max-lifetime"
            prompt="Max lifetime (seconds)"
            description="Maximum total duration for a session (60-28800, default 28800)"
            initialValue="28800"
            onSubmit={wizard.setMaxLifetime}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              const num = parseInt(value, 10);
              if (isNaN(num) || num < 60 || num > 28800) return 'Must be between 60 and 28800';
              // Enforce idle <= maxLifetime inline (idle-timeout is collected first) rather than
              // deferring this cross-field rule to schema-write where it surfaces as a late error.
              if (wizard.config.idleTimeout !== undefined && num < wizard.config.idleTimeout) {
                return `Max lifetime must be >= idle timeout (${wizard.config.idleTimeout}s)`;
              }
              return true;
            }}
          />
        )}

        {isMaxIterationsStep && (
          <TextInput
            key="max-iterations"
            prompt="Max iterations"
            description="Maximum number of agent reasoning loops per turn (default 10)"
            initialValue="10"
            onSubmit={wizard.setMaxIterations}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              const num = parseInt(value, 10);
              return !isNaN(num) && num > 0 ? true : 'Must be a positive number';
            }}
          />
        )}

        {isMaxTokensStep && (
          <TextInput
            key="max-tokens"
            prompt="Max tokens"
            description="Maximum tokens the model can generate per turn (default 4096)"
            initialValue="4096"
            onSubmit={wizard.setMaxTokens}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              const num = parseInt(value, 10);
              return !isNaN(num) && num > 0 ? true : 'Must be a positive number';
            }}
          />
        )}

        {isTimeoutStep && (
          <TextInput
            key="timeout"
            prompt="Timeout (seconds)"
            description="Maximum wall-clock time per agent turn (default 300)"
            initialValue="300"
            onSubmit={wizard.setTimeoutSeconds}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              const num = parseInt(value, 10);
              return !isNaN(num) && num > 0 ? true : 'Must be a positive number';
            }}
          />
        )}

        {isTemperatureStep && (
          <TextInput
            key="temperature"
            prompt="Temperature (optional, 0.0-2.0)"
            description="Sampling temperature; press Enter to skip"
            initialValue=""
            allowEmpty
            onSubmit={wizard.setTemperature}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              if (value.trim() === '') return true;
              const num = parseFloat(value);
              return !isNaN(num) && num >= 0 && num <= 2 ? true : 'Must be between 0.0 and 2.0';
            }}
          />
        )}

        {isTopPStep && (
          <TextInput
            key="top-p"
            prompt="Top P (optional, 0.0-1.0)"
            description="Nucleus sampling probability; press Enter to skip"
            initialValue=""
            allowEmpty
            onSubmit={wizard.setTopP}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              if (value.trim() === '') return true;
              const num = parseFloat(value);
              return !isNaN(num) && num >= 0 && num <= 1 ? true : 'Must be between 0.0 and 1.0';
            }}
          />
        )}

        {isTopKStep && (
          <TextInput
            key="top-k"
            prompt="Top K (optional, 0-500, gemini only)"
            description="Limits sampling to the top K tokens; press Enter to skip"
            initialValue=""
            allowEmpty
            onSubmit={wizard.setTopK}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              if (value.trim() === '') return true;
              const num = parseInt(value, 10);
              return !isNaN(num) && num >= 0 && num <= 500 ? true : 'Must be an integer between 0 and 500';
            }}
          />
        )}

        {isModelMaxTokensStep && (
          <TextInput
            key="model-max-tokens"
            prompt="Model max tokens (optional)"
            description="Per-call model output cap; distinct from execution max-tokens. Press Enter to skip"
            initialValue=""
            allowEmpty
            onSubmit={wizard.setModelMaxTokens}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              if (value.trim() === '') return true;
              const num = parseInt(value, 10);
              return !isNaN(num) && num > 0 ? true : 'Must be a positive integer';
            }}
          />
        )}

        {isMessagesCountStep && (
          <TextInput
            key="memory-messages-count"
            prompt="Memory messages count (optional)"
            description="Recent-message window loaded into context; press Enter to skip"
            initialValue=""
            allowEmpty
            onSubmit={wizard.setMessagesCount}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              if (value.trim() === '') return true;
              const num = parseInt(value, 10);
              return !isNaN(num) && num >= 1 ? true : 'Must be a positive integer';
            }}
          />
        )}

        {isMemoryRetrievalTopKStep && (
          <TextInput
            key="memory-retrieval-top-k"
            prompt="Memory retrieval top K (optional)"
            description="Retrieved-record cap per namespace; press Enter to skip"
            initialValue=""
            allowEmpty
            onSubmit={wizard.setMemoryTopK}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              if (value.trim() === '') return true;
              const num = parseInt(value, 10);
              return !isNaN(num) && num >= 1 ? true : 'Must be a positive integer';
            }}
          />
        )}

        {isMemoryRelevanceScoreStep && (
          <TextInput
            key="memory-relevance-score"
            prompt="Memory relevance score (optional, 0.0-1.0)"
            description="Minimum relevance score for retrieved records; press Enter to skip"
            initialValue=""
            allowEmpty
            onSubmit={wizard.setMemoryRelevanceScore}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              if (value.trim() === '') return true;
              const num = parseFloat(value);
              return !isNaN(num) && num >= 0 && num <= 1 ? true : 'Must be between 0.0 and 1.0';
            }}
          />
        )}

        {isAllowedToolsStep && (
          <TextInput
            key="allowed-tools"
            prompt='Allowed tools (comma-separated, optional, e.g. "*" or "browser,code-interpreter")'
            description="Restrict which tools the agent may invoke. Press Enter to skip"
            initialValue=""
            allowEmpty
            onSubmit={wizard.setAllowedTools}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              if (value.trim() === '') return true;
              const items = value
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);
              if (items.length === 0) return true;
              const bad = items.find(t => t.length > 64 || !/^(\*|@?[^/]+(\/[^/]+)?)$/.test(t));
              return bad ? `Invalid pattern "${bad}" (use "*" or a tool name, max 64 chars)` : true;
            }}
          />
        )}

        {isTruncationStrategyStep && (
          <WizardSelect
            title="Truncation strategy"
            description="How to manage context when it exceeds limits"
            items={truncationStrategyItems}
            selectedIndex={truncationStrategyNav.selectedIndex}
          />
        )}

        {isSessionStoragePathStep && (
          <TextInput
            key="session-storage-path"
            prompt="Session storage mount path (e.g., /mnt/data/)"
            description="Absolute path where persistent storage is mounted inside the session"
            initialValue="/mnt/data/"
            onSubmit={wizard.setSessionStoragePath}
            onCancel={() => wizard.goBack()}
            customValidation={value => (value.startsWith('/') ? true : 'Must be an absolute path')}
          />
        )}

        {isEfsArnStep && (
          <>
            {wizard.config.networkMode !== 'VPC' && (
              <Text color="yellow">⚠ EFS mounts require VPC network mode. Press Enter to skip or Esc to go back.</Text>
            )}
            <TextInput
              key="efs-arn"
              prompt={
                wizard.editingEfsIndex >= 0
                  ? `Edit EFS access point ARN (mount ${wizard.editingEfsIndex + 1}/${MAX_EFS_MOUNTS}):`
                  : `EFS access point ARN ${(wizard.config.efsAccessPoints?.length ?? 0) + 1}/${MAX_EFS_MOUNTS} (press Enter to skip):`
              }
              initialValue={wizard.editingEfsIndex >= 0 ? wizard.pendingEfsArn : ''}
              allowEmpty={wizard.editingEfsIndex < 0}
              customValidation={value => {
                if (!value && wizard.editingEfsIndex < 0) return true;
                if (wizard.config.networkMode !== 'VPC') return 'EFS mounts require VPC network mode';
                const r = validateEfsAccessPointArn(value);
                return r === true ? true : r;
              }}
              onSubmit={wizard.submitEfsArn}
              onCancel={() => wizard.goBack()}
            />
          </>
        )}

        {isEfsMountPathStep && (
          <TextInput
            key="efs-mount-path"
            prompt={`EFS mount path for ...${wizard.pendingEfsArn.slice(-20)} (e.g. /mnt/efs-data):`}
            initialValue={
              wizard.editingEfsIndex >= 0
                ? (wizard.config.efsAccessPoints?.[wizard.editingEfsIndex]?.mountPath ?? '')
                : ''
            }
            customValidation={value => {
              const r = validateBYOMountPath(value);
              return r === true ? true : r;
            }}
            onSubmit={wizard.submitEfsMountPath}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isEfsAddAnotherStep && (
          <SelectList items={efsAddAnotherItems} selectedIndex={efsAddAnotherNav.selectedIndex} />
        )}

        {isS3ArnStep && (
          <>
            {wizard.config.networkMode !== 'VPC' && (
              <Text color="yellow">
                ⚠ S3 Files mounts require VPC network mode. Press Enter to skip or Esc to go back.
              </Text>
            )}
            <TextInput
              key="s3-arn"
              prompt={
                wizard.editingS3Index >= 0
                  ? `Edit S3 Files access point ARN (mount ${wizard.editingS3Index + 1}/${MAX_S3_MOUNTS}):`
                  : `S3 Files access point ARN ${(wizard.config.s3AccessPoints?.length ?? 0) + 1}/${MAX_S3_MOUNTS} (press Enter to skip):`
              }
              initialValue={wizard.editingS3Index >= 0 ? wizard.pendingS3Arn : ''}
              allowEmpty={wizard.editingS3Index < 0}
              customValidation={value => {
                if (!value && wizard.editingS3Index < 0) return true;
                if (wizard.config.networkMode !== 'VPC') return 'S3 Files mounts require VPC network mode';
                const r = validateS3FilesAccessPointArn(value);
                return r === true ? true : r;
              }}
              onSubmit={wizard.submitS3Arn}
              onCancel={() => wizard.goBack()}
            />
          </>
        )}

        {isS3MountPathStep && (
          <TextInput
            key="s3-mount-path"
            prompt={`S3 Files mount path for ...${wizard.pendingS3Arn.slice(-20)} (e.g. /mnt/s3-data):`}
            initialValue={
              wizard.editingS3Index >= 0 ? (wizard.config.s3AccessPoints?.[wizard.editingS3Index]?.mountPath ?? '') : ''
            }
            customValidation={value => {
              const r = validateBYOMountPath(value);
              return r === true ? true : r;
            }}
            onSubmit={wizard.submitS3MountPath}
            onCancel={() => wizard.goBack()}
          />
        )}

        {isS3AddAnotherStep && <SelectList items={s3AddAnotherItems} selectedIndex={s3AddAnotherNav.selectedIndex} />}

        {isConfirmStep && <ConfirmReview fields={confirmFields} />}
      </Panel>
    </Screen>
  );
}
