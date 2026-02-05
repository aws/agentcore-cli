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
import type { AgentRenderConfig } from '../../../templates/types';
import {
  DEFAULT_MEMORY_EXPIRY_DAYS,
  DEFAULT_NETWORK_MODE,
  DEFAULT_PYTHON_ENTRYPOINT,
  DEFAULT_PYTHON_VERSION,
} from '../../../tui/screens/generate/defaults';
import type { GenerateConfig, MemoryOption } from '../../../tui/screens/generate/types';

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
 * Compute the qualified credential name for AWS resources.
 * Format: {projectName}{providerName}
 */
function computeQualifiedCredentialName(projectName: string, providerName: string): string {
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
      name: computeQualifiedCredentialName(projectName, modelProvider),
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
 * Maps GenerateConfig to AgentRenderConfig for template rendering.
 */
export function mapGenerateConfigToRenderConfig(config: GenerateConfig): AgentRenderConfig {
  return {
    name: config.projectName,
    sdkFramework: config.sdk,
    targetLanguage: config.language,
    modelProvider: config.modelProvider,
    hasMemory: config.memory !== 'none',
    hasIdentity: config.modelProvider !== 'Bedrock',
  };
}
