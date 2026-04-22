/**
 * Maps user-facing HarnessSpec (harness.json) to the CreateHarness API wire format.
 *
 * Each transformation is a pure function that converts a section of the spec
 * into the corresponding API field. The top-level mapHarnessSpecToCreateOptions
 * orchestrates them and returns a complete CreateHarnessOptions object.
 */
import type { DeployedResourceState, HarnessSpec } from '../../../../../schema';
import type {
  CreateHarnessOptions,
  HarnessEnvironmentArtifact,
  HarnessEnvironmentProvider,
  HarnessMemoryConfiguration,
  HarnessModelConfiguration,
  HarnessSkill,
  HarnessSystemPrompt,
  HarnessTool,
  HarnessTruncationConfiguration,
} from '../../../../aws/agentcore-harness';
import { toPascalId } from '../../../../cloudformation/logical-ids';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';

const MAX_PROMPT_FILE_SIZE = 1024 * 1024; // 1 MB

// ============================================================================
// Public Interface
// ============================================================================

export interface MapHarnessOptions {
  harnessSpec: HarnessSpec;
  harnessDir: string;
  executionRoleArn: string;
  region: string;
  projectName: string;
  deployedResources?: DeployedResourceState;
  cdkOutputs?: Record<string, string>;
}

/**
 * Transform a HarnessSpec into CreateHarnessOptions for the control plane API.
 */
export async function mapHarnessSpecToCreateOptions(options: MapHarnessOptions): Promise<CreateHarnessOptions> {
  const { harnessSpec, harnessDir, executionRoleArn, region, projectName, deployedResources, cdkOutputs } = options;

  const result: CreateHarnessOptions = {
    region,
    harnessName: `${projectName}_${harnessSpec.name}`,
    executionRoleArn,
  };

  // Model
  result.model = mapModel(harnessSpec.model);

  // System prompt (may read from disk or auto-discover system-prompt.md)
  if (harnessSpec.systemPrompt !== undefined) {
    result.systemPrompt = await mapSystemPrompt(harnessSpec.systemPrompt, harnessDir);
  } else {
    // Auto-discover system-prompt.md if it exists
    result.systemPrompt = await tryLoadSystemPromptFile(harnessDir);
  }

  // Tools
  if (harnessSpec.tools.length > 0) {
    result.tools = mapTools(harnessSpec.tools);
  }

  // Skills
  if (harnessSpec.skills.length > 0) {
    result.skills = mapSkills(harnessSpec.skills);
  }

  // Allowed tools
  if (harnessSpec.allowedTools) {
    result.allowedTools = harnessSpec.allowedTools;
  }

  // Memory
  if (harnessSpec.memory) {
    result.memory = mapMemory(harnessSpec.memory, deployedResources, cdkOutputs);
  }

  // Truncation
  if (harnessSpec.truncation) {
    result.truncation = mapTruncation(harnessSpec.truncation);
  }

  // Execution limits
  if (harnessSpec.maxIterations !== undefined) {
    result.maxIterations = harnessSpec.maxIterations;
  }
  if (harnessSpec.maxTokens !== undefined) {
    result.maxTokens = harnessSpec.maxTokens;
  }
  if (harnessSpec.timeoutSeconds !== undefined) {
    result.timeoutSeconds = harnessSpec.timeoutSeconds;
  }

  // Container artifact
  if (harnessSpec.containerUri) {
    result.environmentArtifact = mapEnvironmentArtifact(harnessSpec.containerUri);
  } else if (harnessSpec.dockerfile) {
    const builtUri = resolveContainerUriFromOutputs(harnessSpec.name, cdkOutputs);
    if (!builtUri) {
      throw new Error(
        `Harness "${harnessSpec.name}" specifies "dockerfile" but no container URI was found in CDK outputs. ` +
          `Expected a CDK output key starting with "Harness${toPascalId(harnessSpec.name)}ContainerUri".`
      );
    }
    result.environmentArtifact = mapEnvironmentArtifact(builtUri);
  }

  // Environment provider (network + lifecycle)
  const environmentProvider = mapEnvironmentProvider(harnessSpec);
  if (environmentProvider) {
    result.environment = environmentProvider;
  }

  // Environment variables
  if (harnessSpec.environmentVariables) {
    result.environmentVariables = harnessSpec.environmentVariables;
  }

  // Tags
  if (harnessSpec.tags) {
    result.tags = harnessSpec.tags;
  }

  // Authorizer configuration — authorizerType is inferred by the API from the
  // presence of authorizerConfiguration, so only the configuration is forwarded.
  if (harnessSpec.authorizerConfiguration?.customJwtAuthorizer) {
    const jwt = harnessSpec.authorizerConfiguration.customJwtAuthorizer;
    result.authorizerConfiguration = {
      customJWTAuthorizer: {
        discoveryUrl: jwt.discoveryUrl,
        ...(jwt.allowedAudience && { allowedAudience: jwt.allowedAudience }),
        ...(jwt.allowedClients && { allowedClients: jwt.allowedClients }),
        ...(jwt.allowedScopes && { allowedScopes: jwt.allowedScopes }),
        ...(jwt.customClaims && { customClaims: jwt.customClaims }),
      },
    };
  }

  return result;
}

// ============================================================================
// Model Mapping
// ============================================================================

function mapModel(model: HarnessSpec['model']): HarnessModelConfiguration {
  const { provider, modelId, apiKeyArn, temperature, topP, topK, maxTokens } = model;

  switch (provider) {
    case 'bedrock':
      return {
        bedrockModelConfig: {
          modelId,
          ...(temperature !== undefined && { temperature }),
          ...(topP !== undefined && { topP }),
          ...(maxTokens !== undefined && { maxTokens }),
        },
      };
    case 'open_ai':
      return {
        openAiModelConfig: {
          modelId,
          ...(apiKeyArn && { apiKeyArn }),
          ...(temperature !== undefined && { temperature }),
          ...(topP !== undefined && { topP }),
          ...(maxTokens !== undefined && { maxTokens }),
        },
      };
    case 'gemini':
      return {
        geminiModelConfig: {
          modelId,
          ...(apiKeyArn && { apiKeyArn }),
          ...(temperature !== undefined && { temperature }),
          ...(topP !== undefined && { topP }),
          ...(topK !== undefined && { topK }),
          ...(maxTokens !== undefined && { maxTokens }),
        },
      };
  }
}

// ============================================================================
// System Prompt Mapping
// ============================================================================

const FILE_PATH_PATTERN = /^\.\.?\//;
const FILE_EXTENSION_PATTERN = /\.(md|txt)$/;

function isFilePath(value: string): boolean {
  return FILE_PATH_PATTERN.test(value) || FILE_EXTENSION_PATTERN.test(value);
}

async function mapSystemPrompt(prompt: string, harnessDir: string): Promise<HarnessSystemPrompt> {
  let text: string;

  if (isFilePath(prompt)) {
    const filePath = join(harnessDir, prompt);
    const fileStats = await stat(filePath);
    if (fileStats.size > MAX_PROMPT_FILE_SIZE) {
      throw new Error(
        `System prompt file "${prompt}" is too large (${fileStats.size} bytes). Maximum size is ${MAX_PROMPT_FILE_SIZE} bytes.`
      );
    }
    text = await readFile(filePath, 'utf-8');
  } else {
    text = prompt;
  }

  return [{ text }];
}

/**
 * Try to load system-prompt.md from harness directory.
 * Returns undefined if file doesn't exist (harness will have no system prompt).
 */
async function tryLoadSystemPromptFile(harnessDir: string): Promise<HarnessSystemPrompt | undefined> {
  const promptPath = join(harnessDir, 'system-prompt.md');

  try {
    const fileStats = await stat(promptPath);
    if (fileStats.size > MAX_PROMPT_FILE_SIZE) {
      throw new Error(
        `System prompt file "system-prompt.md" is too large (${fileStats.size} bytes). Maximum size is ${MAX_PROMPT_FILE_SIZE} bytes.`
      );
    }
    const text = await readFile(promptPath, 'utf-8');
    return [{ text }];
  } catch (err) {
    // File doesn't exist - return undefined (no system prompt)
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    // Other errors (permissions, etc.) should be thrown
    throw err;
  }
}

// ============================================================================
// Tools Mapping
// ============================================================================

function mapTools(tools: HarnessSpec['tools']): HarnessTool[] {
  return tools.map(tool => ({
    type: tool.type,
    name: tool.name,
    ...(tool.config && { config: tool.config as unknown as Record<string, unknown> }),
  }));
}

// ============================================================================
// Skills Mapping
// ============================================================================

function mapSkills(skills: string[]): HarnessSkill[] {
  return skills.map(path => ({ path }));
}

// ============================================================================
// Memory Mapping
// ============================================================================

function mapMemory(
  memory: NonNullable<HarnessSpec['memory']>,
  deployedResources?: DeployedResourceState,
  cdkOutputs?: Record<string, string>
): HarnessMemoryConfiguration | undefined {
  // Direct ARN takes precedence
  if (memory.arn) {
    return { memoryArn: memory.arn };
  }

  // Resolve by name from deployed state or CDK outputs
  if (memory.name) {
    // Try deployed state first
    const deployedMemory = deployedResources?.memories?.[memory.name];
    if (deployedMemory) {
      return { memoryArn: deployedMemory.memoryArn };
    }

    // Fall back to CDK outputs
    if (cdkOutputs) {
      const memoryArn = resolveMemoryArnFromOutputs(memory.name, cdkOutputs);
      if (memoryArn) {
        return { memoryArn };
      }
    }

    throw new Error(
      `Memory "${memory.name}" referenced by harness is not in deployed state. Ensure the memory is defined in agentcore.json and has been deployed.`
    );
  }

  return undefined;
}

/**
 * Resolve memory ARN from CDK stack outputs.
 * The CDK construct exports memory ARNs with keys matching:
 *   ApplicationMemory{PascalName}ArnOutput...
 */
function resolveMemoryArnFromOutputs(memoryName: string, cdkOutputs: Record<string, string>): string | undefined {
  const pascalName = toPascalId(memoryName);
  const prefix = `ApplicationMemory${pascalName}ArnOutput`;

  for (const [key, value] of Object.entries(cdkOutputs)) {
    if (key.startsWith(prefix)) {
      return value;
    }
  }

  return undefined;
}

// ============================================================================
// Truncation Mapping
// ============================================================================

function mapTruncation(truncation: NonNullable<HarnessSpec['truncation']>): HarnessTruncationConfiguration {
  return {
    strategy: truncation.strategy,
    config: truncation.config as HarnessTruncationConfiguration['config'],
  };
}

// ============================================================================
// Container URI Resolution (from CDK outputs for dockerfile-based harnesses)
// ============================================================================

function resolveContainerUriFromOutputs(harnessName: string, cdkOutputs?: Record<string, string>): string | undefined {
  if (!cdkOutputs) return undefined;

  const pascalName = toPascalId(harnessName);
  const prefix = `Harness${pascalName}ContainerUri`;

  for (const [key, value] of Object.entries(cdkOutputs)) {
    if (key.startsWith(prefix)) {
      return value;
    }
  }

  return undefined;
}

// ============================================================================
// Container / Environment Artifact Mapping
// ============================================================================

function mapEnvironmentArtifact(containerUri: string): HarnessEnvironmentArtifact {
  return {
    containerConfiguration: { containerUri },
  };
}

// ============================================================================
// Environment Provider (Network + Lifecycle) Mapping
// ============================================================================

function mapEnvironmentProvider(spec: HarnessSpec): HarnessEnvironmentProvider | undefined {
  const hasNetwork = !!spec.networkConfig;
  const hasLifecycle = !!spec.lifecycleConfig;
  const hasSessionStorage = !!spec.sessionStoragePath;

  if (!hasNetwork && !hasLifecycle && !hasSessionStorage) {
    return undefined;
  }

  const agentCoreRuntimeEnvironment: Record<string, unknown> = {};

  if (spec.networkConfig) {
    agentCoreRuntimeEnvironment.networkConfiguration = {
      networkMode: 'VPC',
      networkModeConfig: {
        subnets: spec.networkConfig.subnets,
        securityGroups: spec.networkConfig.securityGroups,
      },
    };
  }

  if (spec.lifecycleConfig) {
    agentCoreRuntimeEnvironment.lifecycleConfiguration = spec.lifecycleConfig;
  }

  if (spec.sessionStoragePath) {
    agentCoreRuntimeEnvironment.filesystemConfigurations = [{ sessionStorage: { mountPath: spec.sessionStoragePath } }];
  }

  return {
    agentCoreRuntimeEnvironment,
  };
}
