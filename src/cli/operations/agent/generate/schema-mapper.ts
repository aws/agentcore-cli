import { APP_DIR, ConfigIO } from '../../../../lib';
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
import { GatewayPrimitive } from '../../../primitives/GatewayPrimitive';
import { buildAuthorizerConfigFromJwtConfig } from '../../../primitives/auth-utils';
import {
  computeDefaultCredentialEnvVarName,
  computeManagedOAuthCredentialName,
} from '../../../primitives/credential-utils';
import type {
  AgentRenderConfig,
  GatewayProviderRenderConfig,
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
  const protocol = config.protocol ?? 'HTTP';
  const networkMode = config.networkMode ?? DEFAULT_NETWORK_MODE;

  return {
    type: 'AgentCoreRuntime',
    name: config.projectName,
    build: config.buildType ?? 'CodeZip',
    entrypoint: DEFAULT_PYTHON_ENTRYPOINT as FilePath,
    codeLocation: codeLocation as DirectoryPath,
    runtimeVersion: DEFAULT_PYTHON_VERSION,
    networkMode,
    protocol,
    ...(networkMode === 'VPC' &&
      config.subnets &&
      config.securityGroups && {
        networkConfig: {
          subnets: config.subnets,
          securityGroups: config.securityGroups,
        },
      }),
    ...(config.requestHeaderAllowlist?.length && {
      requestHeaderAllowlist: config.requestHeaderAllowlist,
    }),
    ...(config.authorizerType && { authorizerType: config.authorizerType }),
    ...(config.authorizerType === 'CUSTOM_JWT' &&
      config.jwtConfig && {
        authorizerConfiguration: buildAuthorizerConfigFromJwtConfig(config.jwtConfig),
      }),
    ...(protocol !== 'MCP' && { modelProvider: config.modelProvider }),
    // MCP uses mcp.run() which is incompatible with the opentelemetry-instrument wrapper
    ...(protocol === 'MCP' && { instrumentation: { enableOtel: false } }),
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
 * Maps gateways to gateway providers for template rendering.
 */
async function mapGatewaysToGatewayProviders(): Promise<GatewayProviderRenderConfig[]> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();

    return project.agentCoreGateways.map(gateway => {
      const config: GatewayProviderRenderConfig = {
        name: gateway.name,
        envVarName: GatewayPrimitive.computeDefaultGatewayEnvVarName(gateway.name),
        authType: gateway.authorizerType,
      };

      if (gateway.authorizerType === 'CUSTOM_JWT' && gateway.authorizerConfiguration?.customJwtAuthorizer) {
        const jwtConfig = gateway.authorizerConfiguration.customJwtAuthorizer;
        const credName = computeManagedOAuthCredentialName(gateway.name);
        const credential = project.credentials.find(c => c.name === credName);

        if (credential) {
          config.credentialProviderName = credName;
          config.discoveryUrl = jwtConfig.discoveryUrl;
          const scopes =
            'allowedScopes' in jwtConfig ? (jwtConfig as { allowedScopes?: string[] }).allowedScopes : undefined;
          if (scopes?.length) {
            config.scopes = scopes.join(' ');
          }
        }
      }

      return config;
    });
  } catch {
    return [];
  }
}

/**
 * Maps GenerateConfig to AgentRenderConfig for template rendering.
 * @param config - Generate config (note: config.projectName is actually the agent name)
 * @param identityProviders - Identity providers to include (caller controls credential naming)
 */
export async function mapGenerateConfigToRenderConfig(
  config: GenerateConfig,
  identityProviders: IdentityProviderRenderConfig[]
): Promise<AgentRenderConfig> {
  const isMcp = config.protocol === 'MCP';
  const gatewayProviders = isMcp ? [] : await mapGatewaysToGatewayProviders();

  return {
    name: config.projectName,
    sdkFramework: config.sdk,
    targetLanguage: config.language,
    modelProvider: config.modelProvider,
    hasMemory: isMcp ? false : config.memory !== 'none',
    hasIdentity: isMcp ? false : identityProviders.length > 0,
    hasGateway: gatewayProviders.length > 0,
    isVpc: config.networkMode === 'VPC',
    buildType: config.buildType,
    memoryProviders: isMcp ? [] : mapMemoryOptionToMemoryProviders(config.memory, config.projectName),
    identityProviders: isMcp ? [] : identityProviders,
    gatewayProviders,
    gatewayAuthTypes: [...new Set(gatewayProviders.map(g => g.authType))],
    protocol: config.protocol,
  };
}
