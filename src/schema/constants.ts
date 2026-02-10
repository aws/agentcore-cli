import { z } from 'zod';

// ============================================================================
// Feature Constants (shared across all schemas)
// ============================================================================

export const SDKFrameworkSchema = z.enum(['Strands', 'LangChain_LangGraph', 'CrewAI', 'GoogleADK', 'OpenAIAgents']);
export type SDKFramework = z.infer<typeof SDKFrameworkSchema>;

export const TargetLanguageSchema = z.enum(['Python', 'TypeScript', 'Other']);
export type TargetLanguage = z.infer<typeof TargetLanguageSchema>;

export const ModelProviderSchema = z.enum(['Bedrock', 'Gemini', 'OpenAI', 'Anthropic']);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

/**
 * Matrix defining which model providers are supported for each SDK framework.
 * - Most SDKs support all 4 providers (Bedrock, Anthropic, OpenAI, Gemini)
 * - GoogleADK only supports Gemini (uses Google's native API)
 * - OpenAIAgents only supports OpenAI (uses OpenAI's native API)
 */
export const SDK_MODEL_PROVIDER_MATRIX: Record<SDKFramework, readonly ModelProvider[]> = {
  Strands: ['Bedrock', 'Anthropic', 'OpenAI', 'Gemini'] as const,
  LangChain_LangGraph: ['Bedrock', 'Anthropic', 'OpenAI', 'Gemini'] as const,
  CrewAI: ['Bedrock', 'Anthropic', 'OpenAI', 'Gemini'] as const,
  GoogleADK: ['Gemini'] as const,
  OpenAIAgents: ['OpenAI'] as const,
};

/**
 * Returns the supported model providers for a given SDK framework.
 */
export function getSupportedModelProviders(sdk: SDKFramework): readonly ModelProvider[] {
  return SDK_MODEL_PROVIDER_MATRIX[sdk];
}

/**
 * Checks if a model provider is supported for a given SDK framework.
 */
export function isModelProviderSupported(sdk: SDKFramework, provider: ModelProvider): boolean {
  return SDK_MODEL_PROVIDER_MATRIX[sdk].includes(provider);
}

// ============================================================================
// Reserved Project Names (Python package conflicts)
// ============================================================================

/**
 * Project/agent names that would conflict with Python package names when
 * creating a virtual environment. If the project directory name matches
 * a dependency name, uv/pip will fail to resolve dependencies correctly.
 *
 * This list includes all dependencies used across SDK templates, normalized
 * to valid project name format (lowercase, underscores replaced with nothing
 * since project names are alphanumeric only).
 */
export const RESERVED_PROJECT_NAMES: readonly string[] = [
  // Core SDK packages
  'anthropic',
  'autogen',
  'autogenagentchat',
  'autogenext',
  'bedrock',
  'bedrockagentcore',
  'crewai',
  'crewaitools',
  'googleadk',
  'googlegenerativeai',
  'langchain',
  'langchainanthropic',
  'langchainaws',
  'langchaingooglegenai',
  'langchainmcpadapters',
  'langchainopenai',
  'langgraph',
  'mcp',
  'openai',
  'openaiagents',
  'strands',
  'strandsagents',
  'strandsagentstools',
  // Common utilities
  'httpx',
  'pytest',
  'pytestasyncio',
  'pythondotenv',
  'tiktoken',
  // Build tools
  'hatchling',
  'setuptools',
  'wheel',
  // AWS packages
  'awsopentelemetrydistro',
  'boto3',
  'botocore',
  // Common Python stdlib/package names that could cause issues
  'test',
  'tests',
  'src',
  'lib',
  'dist',
  'build',
  'env',
  'venv',
  'site',
  'pip',
  'uv',
] as const;

/**
 * Check if a project name is reserved (case-insensitive).
 */
export function isReservedProjectName(name: string): boolean {
  return RESERVED_PROJECT_NAMES.includes(name.toLowerCase());
}

// ============================================================================
// Infrastructure Constants (shared between agent-env and mcp schemas)
// ============================================================================

export const PythonRuntimeSchema = z.enum(['PYTHON_3_10', 'PYTHON_3_11', 'PYTHON_3_12', 'PYTHON_3_13']);
export type PythonRuntime = z.infer<typeof PythonRuntimeSchema>;

export const NodeRuntimeSchema = z.enum(['NODE_18', 'NODE_20', 'NODE_22']);
export type NodeRuntime = z.infer<typeof NodeRuntimeSchema>;

/** Combined runtime version schema supporting both Python and Node/TypeScript runtimes */
export const RuntimeVersionSchema = z.union([PythonRuntimeSchema, NodeRuntimeSchema]);
export type RuntimeVersion = z.infer<typeof RuntimeVersionSchema>;

export const NetworkModeSchema = z.enum(['PUBLIC', 'PRIVATE']);
export type NetworkMode = z.infer<typeof NetworkModeSchema>;
