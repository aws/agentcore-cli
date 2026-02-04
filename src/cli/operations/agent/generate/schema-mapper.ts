import { APP_DIR } from '../../../../lib';
import type {
  AgentCoreMemoryProvider,
  AgentEnvSpec,
  DirectoryPath,
  FilePath,
  MemoryStrategy,
  ModelProvider,
  OwnedIdentityProvider,
} from '../../../../schema';
import {
  DEFAULT_MEMORY_EXPIRY_DAYS,
  DEFAULT_NETWORK_MODE,
  DEFAULT_PYTHON_ENTRYPOINT,
  DEFAULT_PYTHON_VERSION,
} from '../../../tui/screens/generate/defaults';
import type { GenerateConfig, MemoryOption } from '../../../tui/screens/generate/types';
import { buildOwnedIdentityProvider } from '../../identity/create-identity';
import { computeDefaultMemoryEnvVarName } from '../../memory/create-memory';

/**
 * Maps GenerateConfig memory option to AgentCore MemoryProviders array.
 *
 * Memory mapping:
 * - "none" -> empty array
 * - "shortTerm" -> [AgentCoreMemoryProvider with Summarization strategy]
 * - "longAndShortTerm" -> [AgentCoreMemoryProvider with Semantic + Summarization + UserPreference strategies]
 *
 * Namespace patterns use {actorId} and {sessionId} placeholders for runtime substitution.
 */
export function mapGenerateInputToMemoryProviders(
  memory: MemoryOption,
  projectName: string
): AgentCoreMemoryProvider[] {
  if (memory === 'none') {
    return [];
  }

  const memoryStrategies: MemoryStrategy[] = [];

  // Long-term memory strategies
  if (memory === 'longAndShortTerm') {
    // Semantic memory for facts
    memoryStrategies.push({
      type: 'SEMANTIC',
      name: `${projectName}SemanticMemory`,
      description: 'Long-term semantic memory for the agent',
      namespaces: ['/users/{actorId}/facts'],
    });

    // User preferences memory
    memoryStrategies.push({
      type: 'USER_PREFERENCE',
      name: `${projectName}UserPreferenceMemory`,
      description: 'User preference memory for the agent',
      namespaces: ['/users/{actorId}/preferences'],
    });
  }

  // Short-term memory uses Summarization strategy
  memoryStrategies.push({
    type: 'SUMMARIZATION',
    name: `${projectName}SummaryMemory`,
    description: 'Short-term summarization memory for the agent',
    namespaces: ['/summaries/{actorId}/{sessionId}'],
  });

  const memoryName = `${projectName}Memory`;
  const memoryProvider: AgentCoreMemoryProvider = {
    type: 'AgentCoreMemory',
    relation: 'own',
    name: memoryName,
    description: `Memory provider for ${projectName}`,
    config: {
      eventExpiryDuration: DEFAULT_MEMORY_EXPIRY_DAYS,
      memoryStrategies,
    },
    envVarName: computeDefaultMemoryEnvVarName(memoryName),
  };

  return [memoryProvider];
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity Provider Mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps model provider to identity providers array.
 * For non-Bedrock providers, creates an owned identity provider entry.
 * Bedrock uses IAM, so no identity provider is needed.
 */
export function mapModelProviderToIdentityProviders(
  modelProvider: ModelProvider,
  projectName: string
): OwnedIdentityProvider[] {
  if (modelProvider === 'Bedrock') {
    return [];
  }

  // Provider name is qualified with project name for uniqueness (e.g., "myProjectOpenAI")
  return [buildOwnedIdentityProvider(modelProvider, projectName)];
}

/**
 * Maps GenerateConfig to AgentEnvSpec for schema persistence.
 *
 * Field mappings:
 * - name: from projectName (used as CloudFormation logical ID)
 * - id: generated as "{projectName}Agent"
 * - sdkFramework: direct mapping from sdk field
 * - targetLanguage: direct mapping from language field
 * - modelProvider: direct mapping from modelProvider field
 * - runtime: CodeZipRuntime with codeLocation from projectPath/projectName
 * - mcpProviders: empty array (user adds via `add mcp` command)
 * - memoryProviders: mapped from memory option
 * - identityProviders: mapped from modelProvider (non-Bedrock gets API key provider)
 * - remoteTools: empty array
 */
export function mapGenerateConfigToAgentEnvSpec(config: GenerateConfig): AgentEnvSpec {
  // CodeLocation is relative to the project root (parent of agentcore/ directory)
  // Agents are placed in app/<agentName>/ directory
  const codeLocation = `${APP_DIR}/${config.projectName}/`;

  return {
    name: config.projectName,
    id: `${config.projectName}Agent`,
    sdkFramework: config.sdk,
    targetLanguage: config.language,
    modelProvider: config.modelProvider,
    runtime: {
      artifact: 'CodeZip',
      name: config.projectName,
      entrypoint: DEFAULT_PYTHON_ENTRYPOINT as FilePath,
      codeLocation: codeLocation as DirectoryPath,
      pythonVersion: DEFAULT_PYTHON_VERSION,
      networkMode: DEFAULT_NETWORK_MODE,
    },
    mcpProviders: [],
    memoryProviders: mapGenerateInputToMemoryProviders(config.memory, config.projectName),
    identityProviders: mapModelProviderToIdentityProviders(config.modelProvider, config.projectName),
    remoteTools: [],
  };
}
