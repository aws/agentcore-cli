import type { BuildType, MemoryStrategyType, ModelProvider, SDKFramework, TargetLanguage } from '../../schema';

/**
 * Identity provider info for template rendering.
 */
export interface IdentityProviderRenderConfig {
  name: string;
  envVarName: string;
}

/**
 * Memory provider info for template rendering.
 */
export interface MemoryProviderRenderConfig {
  name: string;
  envVarName: string;
  /** Strategy types configured for this memory */
  strategies: MemoryStrategyType[];
}

/**
 * Configuration needed by template renderers.
 * This is separate from the v2 Agent schema which only stores runtime config.
 */
export interface AgentRenderConfig {
  name: string;
  sdkFramework: SDKFramework;
  targetLanguage: TargetLanguage;
  modelProvider: ModelProvider;
  hasMemory: boolean;
  hasIdentity: boolean;
  /** Build type: CodeZip (default) or Container */
  buildType?: BuildType;
  /** Memory providers for template rendering */
  memoryProviders: MemoryProviderRenderConfig[];
  /** Identity providers for template rendering (maps to credentials in schema) */
  identityProviders: IdentityProviderRenderConfig[];
}
