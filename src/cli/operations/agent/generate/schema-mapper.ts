import { APP_DIR } from '../../../../lib';
import type {
  AgentEnvSpec,
  Credential,
  DirectoryPath,
  FilePath,
  Memory,
  MemoryStrategy,
  ModelProvider,
} from '../../../../schema';
import type { AgentRenderConfig, IdentityProviderRenderConfig } from '../../../templates/types';
import {
  DEFAULT_MEMORY_EXPIRY_DAYS,
  DEFAULT_NETWORK_MODE,
  DEFAULT_PYTHON_ENTRYPOINT,
  DEFAULT_PYTHON_VERSION,
} from '../../../tui/screens/generate/defaults';
import type { GenerateConfig, MemoryOption } from '../../../tui/screens/generate/types';
import { computeDefaultCredentialEnvVarName } from '../../identity/create-identity';

/**
 * Result of mapping GenerateConfig to v2 schema.
 * Returns separate agent, memory, and credential resources.
 */
export interface GenerateConfigMappingResult {
  agent: AgentEnvSpec;
  memories: Memory[];
  credentials: Credential[];
}

/**
 * Compute the credential name for a model provider.
 * Scoped to project (not agent) to avoid conflicts across projects.
 * Format: {projectName}{providerName}
 */
function computeCredentialName(projectName: string, providerName: string): string {
  return `${projectName}${providerName}`;
}

/**
 * Maps GenerateConfig memory option to v2 Memory resources.
 *
 * Memory mapping:
 * - "none" -> empty array
 * - "shortTerm" -> [Memory with Summarization strategy]
 * - "longAndShortTerm" -> [Memory with Semantic + Summarization + UserPreference strategies]
 */
export function mapGenerateInputToMemories(memory: MemoryOption, projectName: string): Memory[] {
  if (memory === 'none') {
    return [];
  }

  const strategies: MemoryStrategy[] = [];

  if (memory === 'longAndShortTerm') {
    strategies.push({ type: 'SEMANTIC' });
    strategies.push({ type: 'USER_PREFERENCE' });
  }

  strategies.push({ type: 'SUMMARIZATION' });

  return [
    {
      type: 'AgentCoreMemory',
      name: `${projectName}Memory`,
      eventExpiryDuration: DEFAULT_MEMORY_EXPIRY_DAYS,
      strategies,
    },
  ];
}

/**
 * Maps model provider to v2 Credential resources.
 * Bedrock uses IAM, so no credential is needed.
 */
export function mapModelProviderToCredentials(modelProvider: ModelProvider, projectName: string): Credential[] {
  if (modelProvider === 'Bedrock') {
    return [];
  }

  return [
    {
      type: 'ApiKeyCredentialProvider',
      name: computeCredentialName(projectName, modelProvider),
    },
  ];
}

/**
 * Maps GenerateConfig to v2 AgentEnvSpec resource.
 */
export function mapGenerateConfigToAgent(config: GenerateConfig): AgentEnvSpec {
  const codeLocation = `${APP_DIR}/${config.projectName}/`;

  return {
    type: 'AgentCoreRuntime',
    name: config.projectName,
    build: 'CodeZip',
    entrypoint: DEFAULT_PYTHON_ENTRYPOINT as FilePath,
    codeLocation: codeLocation as DirectoryPath,
    runtimeVersion: DEFAULT_PYTHON_VERSION,
    networkMode: DEFAULT_NETWORK_MODE,
  };
}

/**
 * Maps GenerateConfig to v2 schema resources (AgentEnvSpec, Memory[], Credential[]).
 */
export function mapGenerateConfigToResources(config: GenerateConfig): GenerateConfigMappingResult {
  return {
    agent: mapGenerateConfigToAgent(config),
    memories: mapGenerateInputToMemories(config.memory, config.projectName),
    credentials: mapModelProviderToCredentials(config.modelProvider, config.projectName),
  };
}

/**
 * Maps model provider to identity providers for template rendering.
 */
function mapModelProviderToIdentityProviders(
  modelProvider: ModelProvider,
  projectName: string
): IdentityProviderRenderConfig[] {
  if (modelProvider === 'Bedrock') {
    return [];
  }

  const credentialName = computeCredentialName(projectName, modelProvider);
  return [
    {
      name: credentialName,
      envVarName: computeDefaultCredentialEnvVarName(credentialName),
    },
  ];
}

/**
 * Maps GenerateConfig to AgentRenderConfig for template rendering.
 * @param config - Generate config (note: config.projectName is actually the agent name)
 * @param actualProjectName - Optional actual project name for credential naming (defaults to config.projectName)
 */
export function mapGenerateConfigToRenderConfig(config: GenerateConfig, actualProjectName?: string): AgentRenderConfig {
  // Use actualProjectName for credential naming, fallback to config.projectName (agent name) for standalone generate
  const projectNameForCredentials = actualProjectName ?? config.projectName;
  return {
    name: config.projectName,
    sdkFramework: config.sdk,
    targetLanguage: config.language,
    modelProvider: config.modelProvider,
    hasMemory: config.memory !== 'none',
    hasIdentity: config.modelProvider !== 'Bedrock',
    identityProviders: mapModelProviderToIdentityProviders(config.modelProvider, projectNameForCredentials),
  };
}
