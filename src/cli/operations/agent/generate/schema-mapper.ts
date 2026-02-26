import { APP_DIR } from '../../../../lib';
import type {
  AgentEnvSpec,
  Credential,
  DirectoryPath,
  FilePath,
  Memory,
  MemoryStrategy,
  MemoryStrategyType,
  ModelProvider,
} from '../../../../schema';
import { DEFAULT_STRATEGY_NAMESPACES } from '../../../../schema';
import type {
  AgentRenderConfig,
  IdentityProviderRenderConfig,
  MemoryProviderRenderConfig,
} from '../../../templates/types';
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
 * - "none" -> empty array (no memory)
 * - "shortTerm" -> [Memory with no strategies] (just base memory with expiration)
 * - "longAndShortTerm" -> [Memory with Semantic + Summarization + UserPreference strategies]
 */
export function mapGenerateInputToMemories(memory: MemoryOption, projectName: string): Memory[] {
  if (memory === 'none') {
    return [];
  }

  const strategies: MemoryStrategy[] = [];

  // Short term memory has no strategies - just base memory with expiration time
  // Long term memory includes strategies for semantic search, summarization, and user preferences
  if (memory === 'longAndShortTerm') {
    const strategyTypes: MemoryStrategyType[] = ['SEMANTIC', 'USER_PREFERENCE', 'SUMMARIZATION'];
    for (const type of strategyTypes) {
      const defaultNamespaces = DEFAULT_STRATEGY_NAMESPACES[type];
      strategies.push({
        type,
        ...(defaultNamespaces && { namespaces: defaultNamespaces }),
      });
    }
  }

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
    build: config.buildType ?? 'CodeZip',
    entrypoint: DEFAULT_PYTHON_ENTRYPOINT as FilePath,
    codeLocation: codeLocation as DirectoryPath,
    runtimeVersion: DEFAULT_PYTHON_VERSION,
    networkMode: DEFAULT_NETWORK_MODE,
    modelProvider: config.modelProvider,
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
 * Compute the memory env var name for a memory resource.
 * Pattern: MEMORY_{NAME}_ID (matches CDK construct pattern)
 */
function computeMemoryEnvVarName(memoryName: string): string {
  return `MEMORY_${memoryName.toUpperCase()}_ID`;
}

/**
 * Maps memory option to memory providers for template rendering.
 */
function mapMemoryOptionToMemoryProviders(memory: MemoryOption, projectName: string): MemoryProviderRenderConfig[] {
  if (memory === 'none') {
    return [];
  }

  const memoryName = `${projectName}Memory`;
  const strategies = mapGenerateInputToMemories(memory, projectName)[0]?.strategies ?? [];

  return [
    {
      name: memoryName,
      envVarName: computeMemoryEnvVarName(memoryName),
      strategies: strategies.map(s => s.type),
    },
  ];
}

/**
 * Maps model provider to identity providers for template rendering.
 * Bedrock uses IAM, so no identity provider is needed.
 */
export function mapModelProviderToIdentityProviders(
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
 * @param identityProviders - Identity providers to include (caller controls credential naming)
 */
export function mapGenerateConfigToRenderConfig(
  config: GenerateConfig,
  identityProviders: IdentityProviderRenderConfig[]
): AgentRenderConfig {
  return {
    name: config.projectName,
    sdkFramework: config.sdk,
    targetLanguage: config.language,
    modelProvider: config.modelProvider,
    hasMemory: config.memory !== 'none',
    hasIdentity: identityProviders.length > 0,
    buildType: config.buildType,
    memoryProviders: mapMemoryOptionToMemoryProviders(config.memory, config.projectName),
    identityProviders,
  };
}
