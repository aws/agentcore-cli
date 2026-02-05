import type { ModelProvider, SDKFramework, TargetLanguage } from '../../schema';

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
}
