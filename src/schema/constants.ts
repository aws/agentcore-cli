import { z } from 'zod';

// ============================================================================
// Feature Constants (shared across all schemas)
// ============================================================================

export const SDKFrameworkSchema = z.enum(['Strands', 'LangChain_LangGraph', 'GoogleADK', 'OpenAIAgents', 'VercelAI']);
export type SDKFramework = z.infer<typeof SDKFrameworkSchema>;

export const TargetLanguageSchema = z.enum(['Python', 'TypeScript', 'Other']);
export type TargetLanguage = z.infer<typeof TargetLanguageSchema>;

export const ModelProviderSchema = z.enum(['Bedrock', 'Gemini', 'OpenAI', 'Anthropic']);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

/** Providers that use credentials (Bedrock uses IAM, no credential needed). */
export const CREDENTIAL_PROVIDERS = ['Gemini', 'OpenAI', 'Anthropic'] as const;

/**
 * Case-insensitively match a user-provided value against a Zod enum's options.
 * Returns the canonical (correctly-cased) value, or undefined if no match.
 */
export function matchEnumValue(schema: { options: readonly string[] }, input: string): string | undefined {
  const lower = input.toLowerCase();
  return schema.options.find(v => v.toLowerCase() === lower);
}

/**
 * Default model IDs used for each provider.
 * These are the models generated in agent templates.
 */
export const DEFAULT_MODEL_IDS: Record<ModelProvider, string> = {
  Bedrock: 'us.anthropic.claude-sonnet-4-5-20250514-v1:0',
  Anthropic: 'claude-sonnet-4-5-20250514',
  OpenAI: 'gpt-4.1',
  Gemini: 'gemini-2.5-flash',
};

/**
 * Matrix defining which model providers are supported for each SDK framework.
 * - Most SDKs support all 4 providers (Bedrock, Anthropic, OpenAI, Gemini)
 * - GoogleADK only supports Gemini (uses Google's native API)
 * - OpenAIAgents only supports OpenAI (uses OpenAI's native API)
 */
export const SDK_MODEL_PROVIDER_MATRIX: Record<SDKFramework, readonly ModelProvider[]> = {
  Strands: ['Bedrock', 'Anthropic', 'OpenAI', 'Gemini'] as const,
  LangChain_LangGraph: ['Bedrock', 'Anthropic', 'OpenAI', 'Gemini'] as const,
  GoogleADK: ['Gemini'] as const,
  OpenAIAgents: ['OpenAI'] as const,
  VercelAI: ['Bedrock', 'Anthropic', 'OpenAI', 'Gemini'] as const,
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
  // AG-UI adapter packages
  'agui',
  'aguistrands',
  'aguilanggraph',
  'aguiadk',
  'aguiprotocol',
  'vercelai',
  'aisdk',
  // Common utilities
  'httpx',
  'pytest',
  'pytestasyncio',
  'pythondotenv',
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

export const PythonRuntimeSchema = z.enum(['PYTHON_3_10', 'PYTHON_3_11', 'PYTHON_3_12', 'PYTHON_3_13', 'PYTHON_3_14']);
export type PythonRuntime = z.infer<typeof PythonRuntimeSchema>;

/** Default Python runtime version for new agents and MCP tools */
export const DEFAULT_PYTHON_VERSION: PythonRuntime = 'PYTHON_3_14';

export const NodeRuntimeSchema = z.enum(['NODE_18', 'NODE_20', 'NODE_22']);
export type NodeRuntime = z.infer<typeof NodeRuntimeSchema>;

/** Default Node.js runtime version for new TypeScript agents */
export const DEFAULT_NODE_VERSION: NodeRuntime = 'NODE_22';

/** Combined runtime version schema supporting both Python and Node/TypeScript runtimes */
export const RuntimeVersionSchema = z.union([PythonRuntimeSchema, NodeRuntimeSchema]);
export type RuntimeVersion = z.infer<typeof RuntimeVersionSchema>;

/** Default entrypoint filename for each target language (create path). */
export const DEFAULT_ENTRYPOINT_BY_LANGUAGE: Record<'Python' | 'TypeScript', string> = {
  Python: 'main.py',
  TypeScript: 'main.js',
};

/** Default runtime version for each target language (create path). */
export const DEFAULT_RUNTIME_BY_LANGUAGE: Record<'Python' | 'TypeScript', RuntimeVersion> = {
  Python: DEFAULT_PYTHON_VERSION,
  TypeScript: DEFAULT_NODE_VERSION,
};

export const NetworkModeSchema = z.enum(['PUBLIC', 'VPC']);
export type NetworkMode = z.infer<typeof NetworkModeSchema>;

// ============================================================================
// Protocol Mode
// ============================================================================

export const ProtocolModeSchema = z.enum(['HTTP', 'MCP', 'A2A', 'AGUI']);
export type ProtocolMode = z.infer<typeof ProtocolModeSchema>;

/**
 * Matrix defining which SDK frameworks are supported for each protocol mode.
 * MCP is a standalone tool server with no framework.
 */
export const PROTOCOL_FRAMEWORK_MATRIX: Record<ProtocolMode, readonly SDKFramework[]> = {
  HTTP: ['Strands', 'LangChain_LangGraph', 'GoogleADK', 'OpenAIAgents', 'VercelAI'] as const,
  MCP: [] as const,
  A2A: ['Strands', 'GoogleADK', 'LangChain_LangGraph'] as const,
  AGUI: ['Strands', 'LangChain_LangGraph', 'GoogleADK'] as const,
};

/**
 * Returns the supported SDK frameworks for a given protocol mode.
 */
export function getSupportedFrameworksForProtocol(protocol: ProtocolMode): readonly SDKFramework[] {
  return PROTOCOL_FRAMEWORK_MATRIX[protocol];
}

/**
 * Checks if a framework is supported for a given protocol mode.
 */
export function isFrameworkSupportedForProtocol(protocol: ProtocolMode, framework: SDKFramework): boolean {
  return PROTOCOL_FRAMEWORK_MATRIX[protocol].includes(framework);
}
