import type { NetworkMode, RuntimeAuthorizerType } from '../../../../schema';
import {
  DEFAULT_MODEL_IDS,
  LIFECYCLE_TIMEOUT_MAX,
  LIFECYCLE_TIMEOUT_MIN,
  MAX_EFS_MOUNTS,
  MAX_S3_MOUNTS,
  ProjectNameSchema,
  SessionStorageSchema,
} from '../../../../schema';
import {
  validateBYOMountPath,
  validateEfsAccessPointArn,
  validateS3FilesAccessPointArn,
} from '../../../commands/shared/filesystem-utils';
import { parseAndNormalizeHeaders, validateHeaderAllowlist } from '../../../commands/shared/header-utils';
import { validateSecurityGroupIds, validateSubnetIds } from '../../../commands/shared/vpc-utils';
import { computeDefaultCredentialEnvVarName } from '../../../primitives/credential-utils';
import {
  ApiKeySecretInput,
  Panel,
  PathInput,
  SelectList,
  StepIndicator,
  TextInput,
  WizardMultiSelect,
} from '../../components';
import type { SelectableItem } from '../../components';
import { JwtConfigInput, useJwtConfigFlow } from '../../components/jwt-config';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { RUNTIME_AUTHORIZER_TYPE_OPTIONS, getProviderInfo } from '../agent/types';
import type { AdvancedSettingId, BuildType, GenerateConfig, GenerateStep, MemoryOption, ProtocolMode } from './types';
import {
  ADVANCED_SETTING_OPTIONS,
  BUILD_TYPE_OPTIONS,
  LANGUAGE_OPTIONS,
  MEMORY_OPTIONS,
  NETWORK_MODE_OPTIONS,
  PROTOCOL_OPTIONS,
  STEP_LABELS,
  getModelProviderOptionsForSdk,
  getProtocolOptionsForLanguage,
  getSDKOptionsForProtocol,
} from './types';
import type { useGenerateWizard } from './useGenerateWizard';
import { Box, Text, useInput } from 'ink';
import { basename } from 'path';

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
        }));
      case 'buildType':
        return BUILD_TYPE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description }));
      case 'protocol':
        return getProtocolOptionsForLanguage(wizard.config.language).map(o => ({
          id: o.id,
          title: o.title,
          description: o.description,
        }));
      case 'sdk':
        return getSDKOptionsForProtocol(wizard.config.protocol, wizard.config.language).map(o => ({
          id: o.id,
          title: o.title,
          description: o.description,
        }));
      case 'modelProvider':
        // Filter model providers based on selected SDK
        return getModelProviderOptionsForSdk(wizard.config.sdk).map(o => ({
          id: o.id,
          title: o.title,
          description: o.description,
        }));
      case 'memory':
        return MEMORY_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description }));
      case 'networkMode':
        return NETWORK_MODE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description }));
      case 'authorizerType':
        return RUNTIME_AUTHORIZER_TYPE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description }));
      default:
        return [];
    }
  };

  const items = getItems();
  const isSelectStep = items.length > 0;
  const isAdvancedStep = wizard.step === 'advanced';
  const isTextStep = wizard.step === 'projectName';
  const isDockerfileStep = wizard.step === 'dockerfile';
  const isApiKeyStep = wizard.step === 'apiKey';
  const isSubnetsStep = wizard.step === 'subnets';
  const isSecurityGroupsStep = wizard.step === 'securityGroups';
  const isRequestHeaderAllowlistStep = wizard.step === 'requestHeaderAllowlist';
  const isJwtConfigStep = wizard.step === 'jwtConfig';
  const isIdleTimeoutStep = wizard.step === 'idleTimeout';
  const isMaxLifetimeStep = wizard.step === 'maxLifetime';
  const isSessionStorageMountPathStep = wizard.step === 'sessionStorageMountPath';
  const isEfsArnStep = wizard.step === 'efsArn';
  const isEfsMountPathStep = wizard.step === 'efsMountPath';
  const isEfsAddAnotherStep = wizard.step === 'efsAddAnother';
  const isS3ArnStep = wizard.step === 's3Arn';
  const isS3MountPathStep = wizard.step === 's3MountPath';
  const isS3AddAnotherStep = wizard.step === 's3AddAnother';
  const isConfirmStep = wizard.step === 'confirm';

  // Advanced multi-select items — filter out options not applicable to current config
  const advancedItems: SelectableItem[] = ADVANCED_SETTING_OPTIONS.filter(
    o =>
      (o.id !== 'dockerfile' || wizard.config.buildType === 'Container') &&
      (o.id !== 'filesystem' || wizard.config.language !== 'TypeScript')
  ).map(o => ({ id: o.id, title: o.title, description: o.description }));

  const handleSelect = (item: SelectableItem) => {
    switch (wizard.step) {
      case 'language':
        wizard.setLanguage(item.id as GenerateConfig['language']);
        break;
      case 'buildType':
        wizard.setBuildType(item.id as BuildType);
        break;
      case 'protocol':
        wizard.setProtocol(item.id as ProtocolMode);
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
      case 'networkMode':
        wizard.setNetworkMode(item.id as NetworkMode);
        break;
      case 'authorizerType':
        wizard.setAuthorizerType(item.id as RuntimeAuthorizerType);
        break;
    }
  };

  const { selectedIndex } = useListNavigation({
    items,
    onSelect: handleSelect,
    onExit: onBack,
    isActive: isActive && isSelectStep && !isAdvancedStep,
    isDisabled: item => item.disabled ?? false,
    resetKey: wizard.step,
  });

  const advancedNav = useMultiSelectNavigation({
    items: advancedItems,
    getId: item => item.id,
    onConfirm: selectedIds => wizard.setAdvanced(selectedIds as AdvancedSettingId[]),
    onExit: onBack,
    isActive: isActive && isAdvancedStep,
    requireSelection: false,
  });

  const efsAddAnotherItems = [
    ...(wizard.config.efsAccessPoints ?? []).flatMap((m, i) => [
      {
        id: `edit:${i}`,
        title: `Edit EFS mount ${i + 1}: ${m.mountPath}`,
        description: m.accessPointArn.slice(-30),
      },
      { id: `remove:${i}`, title: `Remove EFS mount ${i + 1}: ${m.mountPath}` },
    ]),
    ...((wizard.config.efsAccessPoints?.length ?? 0) < MAX_EFS_MOUNTS
      ? [{ id: 'add', title: 'Add another EFS mount', spaceBefore: true }]
      : []),
    { id: 'done', title: 'Continue', spaceBefore: (wizard.config.efsAccessPoints?.length ?? 0) >= MAX_EFS_MOUNTS },
  ];
  const efsAddAnotherNav = useListNavigation({
    items: efsAddAnotherItems,
    onSelect: item => wizard.submitEfsAddAnother(item.id),
    onExit: onBack,
    isActive: isActive && isEfsAddAnotherStep,
    resetKey: wizard.step,
  });

  const s3AddAnotherItems = [
    ...(wizard.config.s3AccessPoints ?? []).flatMap((m, i) => [
      {
        id: `edit:${i}`,
        title: `Edit S3 Files mount ${i + 1}: ${m.mountPath}`,
        description: m.accessPointArn.slice(-30),
      },
      { id: `remove:${i}`, title: `Remove S3 Files mount ${i + 1}: ${m.mountPath}` },
    ]),
    ...((wizard.config.s3AccessPoints?.length ?? 0) < MAX_S3_MOUNTS
      ? [{ id: 'add', title: 'Add another S3 Files mount', spaceBefore: true }]
      : []),
    { id: 'done', title: 'Continue', spaceBefore: (wizard.config.s3AccessPoints?.length ?? 0) >= MAX_S3_MOUNTS },
  ];
  const s3AddAnotherNav = useListNavigation({
    items: s3AddAnotherItems,
    onSelect: item => wizard.submitS3AddAnother(item.id),
    onExit: onBack,
    isActive: isActive && isS3AddAnotherStep,
    resetKey: wizard.step,
  });

  // JWT config flow for CUSTOM_JWT authorizer
  const jwtFlow = useJwtConfigFlow({
    onComplete: jwtConfig => {
      wizard.setJwtConfig(jwtConfig);
    },
    onBack: () => {
      wizard.goBack();
    },
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

      {isSelectStep && !isAdvancedStep && <SelectList items={items} selectedIndex={selectedIndex} />}

      {isAdvancedStep && (
        <WizardMultiSelect
          title="Customize advanced settings"
          description="Select settings to configure. Unselected items use defaults."
          items={advancedItems}
          cursorIndex={advancedNav.cursorIndex}
          selectedIds={advancedNav.selectedIds}
        />
      )}

      {isDockerfileStep && (
        <PathInput
          placeholder="Select a Dockerfile to copy into your agent directory"
          pathType="file"
          allowEmpty
          emptyHelpText="Press Enter to use the default Dockerfile"
          onSubmit={value => {
            wizard.setDockerfile(value ? basename(value) : undefined);
          }}
          onCancel={onBack}
        />
      )}

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

      {isSubnetsStep && (
        <TextInput
          prompt="Subnet IDs (comma-separated)"
          initialValue={(wizard.config.subnets ?? []).join(', ')}
          customValidation={validateSubnetIds}
          onSubmit={value => {
            wizard.setSubnets(
              value
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
            );
          }}
          onCancel={onBack}
        />
      )}

      {isSecurityGroupsStep && (
        <TextInput
          prompt="Security group IDs (comma-separated)"
          initialValue={(wizard.config.securityGroups ?? []).join(', ')}
          customValidation={validateSecurityGroupIds}
          onSubmit={value => {
            wizard.setSecurityGroups(
              value
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
            );
          }}
          onCancel={onBack}
        />
      )}

      {isRequestHeaderAllowlistStep && (
        <Box flexDirection="column">
          <TextInput
            prompt="Allowed request headers (comma-separated, or press Enter to skip)"
            initialValue={(wizard.config.requestHeaderAllowlist ?? []).join(', ')}
            allowEmpty
            customValidation={value => {
              const result = validateHeaderAllowlist(value);
              return result.success ? true : result.error!;
            }}
            onSubmit={value => {
              const headers = parseAndNormalizeHeaders(value);
              if (headers.length > 0) {
                wizard.setRequestHeaderAllowlist(headers);
              } else {
                wizard.skipRequestHeaderAllowlist();
              }
            }}
            onCancel={onBack}
          />
          <Box marginTop={1}>
            <Text dimColor>
              Enter header names (e.g. Authorization, X-Api-Key, X-Custom-Signature). Bare names without X- prefix are
              auto-prefixed with X-Amzn-Bedrock-AgentCore-Runtime-Custom- for backward compatibility.
            </Text>
          </Box>
        </Box>
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
          onDiscoveryUrl={jwtFlow.handlers.handleDiscoveryUrl}
          onConstraintsPicked={jwtFlow.handlers.handleConstraintsPicked}
          onAudience={jwtFlow.handlers.handleAudience}
          onClients={jwtFlow.handlers.handleClients}
          onScopes={jwtFlow.handlers.handleScopes}
          onCustomClaimsDone={jwtFlow.handlers.handleCustomClaimsDone}
          onClientId={jwtFlow.handlers.handleClientId}
          onClientIdSkip={jwtFlow.handlers.handleClientIdSkip}
          onClientSecret={jwtFlow.handlers.handleClientSecret}
          onBack={jwtFlow.goBack}
          onClaimsManagerModeChange={jwtFlow.handlers.handleClaimsManagerModeChange}
        />
      )}

      {isIdleTimeoutStep && (
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
            if (value) {
              wizard.setIdleTimeout(Number(value));
            } else {
              wizard.skipIdleTimeout();
            }
          }}
          onCancel={onBack}
        />
      )}

      {isMaxLifetimeStep && (
        <TextInput
          prompt={`Max instance lifetime in seconds (${LIFECYCLE_TIMEOUT_MIN}-${LIFECYCLE_TIMEOUT_MAX}, or press Enter to skip)`}
          initialValue=""
          allowEmpty
          customValidation={value => {
            if (!value) return true;
            const n = Number(value);
            if (isNaN(n) || !Number.isInteger(n) || n < LIFECYCLE_TIMEOUT_MIN || n > LIFECYCLE_TIMEOUT_MAX)
              return `Must be an integer between ${LIFECYCLE_TIMEOUT_MIN} and ${LIFECYCLE_TIMEOUT_MAX}`;
            if (wizard.config.idleRuntimeSessionTimeout !== undefined && n < wizard.config.idleRuntimeSessionTimeout) {
              return 'Must be >= idle timeout';
            }
            return true;
          }}
          onSubmit={value => {
            if (value) {
              wizard.setMaxLifetime(Number(value));
            } else {
              wizard.skipMaxLifetime();
            }
          }}
          onCancel={onBack}
        />
      )}

      {isSessionStorageMountPathStep && (
        <TextInput
          prompt="Session storage mount path (e.g. /mnt/data, or press Enter to skip)"
          initialValue={wizard.config.sessionStorageMountPath ?? ''}
          allowEmpty
          schema={SessionStorageSchema.shape.mountPath}
          onSubmit={value => {
            if (value) {
              wizard.setSessionStorageMountPath(value);
            } else {
              wizard.skipSessionStorageMountPath();
            }
          }}
          onCancel={onBack}
        />
      )}

      {isEfsArnStep && (
        <>
          {wizard.config.networkMode !== 'VPC' && (
            <Text color="yellow">⚠ EFS mounts require VPC network mode. Press Enter to skip or Esc to go back.</Text>
          )}
          <TextInput
            prompt={
              wizard.editingEfsIndex >= 0
                ? `Edit EFS access point ARN (mount ${wizard.editingEfsIndex + 1}/${MAX_EFS_MOUNTS}):`
                : `EFS access point ARN ${(wizard.config.efsAccessPoints ?? []).length + 1}/${MAX_EFS_MOUNTS} (press Enter to skip):`
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
            onCancel={onBack}
          />
        </>
      )}

      {isEfsMountPathStep && (
        <TextInput
          prompt={`EFS mount path for ...${wizard.pendingEfsArn.slice(-30)} (e.g. /mnt/efs-data):`}
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
          onCancel={onBack}
        />
      )}

      {isEfsAddAnotherStep && <SelectList items={efsAddAnotherItems} selectedIndex={efsAddAnotherNav.selectedIndex} />}

      {isS3ArnStep && (
        <>
          {wizard.config.networkMode !== 'VPC' && (
            <Text color="yellow">
              ⚠ S3 Files mounts require VPC network mode. Press Enter to skip or Esc to go back.
            </Text>
          )}
          <TextInput
            prompt={
              wizard.editingS3Index >= 0
                ? `Edit S3 Files access point ARN (mount ${wizard.editingS3Index + 1}/${MAX_S3_MOUNTS}):`
                : `S3 Files access point ARN ${(wizard.config.s3AccessPoints ?? []).length + 1}/${MAX_S3_MOUNTS} (press Enter to skip):`
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
            onCancel={onBack}
          />
        </>
      )}

      {isS3MountPathStep && (
        <TextInput
          prompt={`S3 Files mount path for ...${wizard.pendingS3Arn.slice(-30)} (e.g. /mnt/s3-data):`}
          initialValue={
            wizard.editingS3Index >= 0 ? (wizard.config.s3AccessPoints?.[wizard.editingS3Index]?.mountPath ?? '') : ''
          }
          customValidation={value => {
            const r = validateBYOMountPath(value);
            return r === true ? true : r;
          }}
          onSubmit={wizard.submitS3MountPath}
          onCancel={onBack}
        />
      )}

      {isS3AddAnotherStep && <SelectList items={s3AddAnotherItems} selectedIndex={s3AddAnotherNav.selectedIndex} />}

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
  if (
    step === 'projectName' ||
    step === 'dockerfile' ||
    step === 'subnets' ||
    step === 'securityGroups' ||
    step === 'requestHeaderAllowlist' ||
    step === 'idleTimeout' ||
    step === 'maxLifetime' ||
    step === 'sessionStorageMountPath' ||
    step === 'efsArn' ||
    step === 'efsMountPath' ||
    step === 's3Arn' ||
    step === 's3MountPath'
  )
    return 'Enter submit · Esc cancel';
  if (step === 'efsAddAnother' || step === 's3AddAnother') return '↑↓ navigate · Enter select · Esc back';
  if (step === 'apiKey') return 'Enter submit · Tab show/hide · Esc back';
  if (step === 'jwtConfig') return 'Enter submit · Esc back';
  if (step === 'advanced') return 'Space toggle · Enter confirm · Esc back';
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
  const buildTypeLabel = BUILD_TYPE_OPTIONS.find(o => o.id === config.buildType)?.title ?? config.buildType;
  const protocolLabel = PROTOCOL_OPTIONS.find(o => o.id === config.protocol)?.title ?? config.protocol;
  const memoryLabel = getMemoryLabel(config.memory);
  const isMcp = config.protocol === 'MCP';

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
          <Text dimColor>Build: </Text>
          <Text>{buildTypeLabel}</Text>
        </Text>
        {config.buildType === 'Container' && config.dockerfile && (
          <Text>
            <Text dimColor>Dockerfile: </Text>
            <Text>{config.dockerfile}</Text>
          </Text>
        )}
        <Text>
          <Text dimColor>Protocol: </Text>
          <Text>{protocolLabel}</Text>
        </Text>
        {!isMcp && (
          <>
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
          </>
        )}
        <Text>
          <Text dimColor>Network: </Text>
          <Text>{config.networkMode ?? 'PUBLIC'}</Text>
        </Text>
        {config.networkMode === 'VPC' && config.subnets && (
          <Text>
            <Text dimColor>Subnets: </Text>
            <Text>{config.subnets.join(', ')}</Text>
          </Text>
        )}
        {config.networkMode === 'VPC' && config.securityGroups && (
          <Text>
            <Text dimColor>Security Groups: </Text>
            <Text>{config.securityGroups.join(', ')}</Text>
          </Text>
        )}
        {config.requestHeaderAllowlist && config.requestHeaderAllowlist.length > 0 && (
          <Text>
            <Text dimColor>Headers: </Text>
            <Text>{config.requestHeaderAllowlist.join(', ')}</Text>
          </Text>
        )}
        {config.authorizerType && config.authorizerType !== 'AWS_IAM' && (
          <Text>
            <Text dimColor>Inbound Auth: </Text>
            <Text>
              {RUNTIME_AUTHORIZER_TYPE_OPTIONS.find(o => o.id === config.authorizerType)?.title ??
                config.authorizerType}
            </Text>
          </Text>
        )}
        {config.authorizerType === 'CUSTOM_JWT' && config.jwtConfig && (
          <>
            <Text>
              <Text dimColor>Discovery URL: </Text>
              <Text>{config.jwtConfig.discoveryUrl}</Text>
            </Text>
            {config.jwtConfig.allowedAudience && config.jwtConfig.allowedAudience.length > 0 && (
              <Text>
                <Text dimColor>Allowed Audience: </Text>
                <Text>{config.jwtConfig.allowedAudience.join(', ')}</Text>
              </Text>
            )}
          </>
        )}
        {config.idleRuntimeSessionTimeout !== undefined && (
          <Text>
            <Text dimColor>Idle Timeout: </Text>
            <Text>{config.idleRuntimeSessionTimeout}s</Text>
          </Text>
        )}
        {config.maxLifetime !== undefined && (
          <Text>
            <Text dimColor>Max Lifetime: </Text>
            <Text>{config.maxLifetime}s</Text>
          </Text>
        )}
        {config.sessionStorageMountPath && (
          <Text>
            <Text dimColor>Session Storage: </Text>
            <Text>{config.sessionStorageMountPath}</Text>
          </Text>
        )}
        {(config.efsAccessPoints ?? []).map((m, i) => (
          <Text key={i}>
            <Text dimColor>EFS Mount {i + 1}: </Text>
            <Text>
              {m.accessPointArn.slice(-30)} → {m.mountPath}
            </Text>
          </Text>
        ))}
        {(config.s3AccessPoints ?? []).map((m, i) => (
          <Text key={i}>
            <Text dimColor>S3 Files Mount {i + 1}: </Text>
            <Text>
              {m.accessPointArn.slice(-30)} → {m.mountPath}
            </Text>
          </Text>
        ))}
        {config.withConfigBundle && (
          <Text>
            <Text dimColor>Config Bundle: </Text>
            <Text color="green">Yes (auto-created on deploy)</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}
