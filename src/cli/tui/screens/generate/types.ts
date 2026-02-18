import type { BuildType, ModelProvider, SDKFramework, TargetLanguage } from '../../../../schema';
import { DEFAULT_MODEL_IDS, getSupportedModelProviders } from '../../../../schema';

export type GenerateStep =
  | 'projectName'
  | 'language'
  | 'buildType'
  | 'sdk'
  | 'modelProvider'
  | 'apiKey'
  | 'memory'
  | 'confirm';

export type MemoryOption = 'none' | 'shortTerm' | 'longAndShortTerm';

// Re-export types from schema for convenience
export type { BuildType, ModelProvider, SDKFramework, TargetLanguage };

export interface GenerateConfig {
  projectName: string;
  buildType: BuildType;
  sdk: SDKFramework;
  modelProvider: ModelProvider;
  /** API key for non-Bedrock model providers (optional - can be added later) */
  apiKey?: string;
  memory: MemoryOption;
  language: TargetLanguage;
}

/** Base steps - apiKey and memory are conditionally added based on selections */
export const BASE_GENERATE_STEPS: GenerateStep[] = [
  'projectName',
  'language',
  'buildType',
  'sdk',
  'modelProvider',
  'apiKey',
  'confirm',
];

export const STEP_LABELS: Record<GenerateStep, string> = {
  projectName: 'Name',
  language: 'Target Language',
  buildType: 'Build',
  sdk: 'Framework',
  modelProvider: 'Model',
  apiKey: 'API Key',
  memory: 'Memory',
  confirm: 'Confirm',
};

export const LANGUAGE_OPTIONS = [
  { id: 'Python', title: 'Python' },
  { id: 'TypeScript', title: 'TypeScript (coming soon)', disabled: true },
] as const;

export const BUILD_TYPE_OPTIONS = [
  { id: 'CodeZip', title: 'Direct Code Deploy', description: 'Upload code directly to AgentCore' },
  { id: 'Container', title: 'Container', description: 'Build and deploy a Docker container' },
] as const;

export const SDK_OPTIONS = [
  { id: 'Strands', title: 'Strands Agents SDK', description: 'AWS native agent framework' },
  { id: 'LangChain_LangGraph', title: 'LangChain + LangGraph', description: 'Popular open-source frameworks' },
  { id: 'GoogleADK', title: 'Google ADK', description: 'Google Agent Development Kit' },
  { id: 'OpenAIAgents', title: 'OpenAI Agents', description: 'OpenAI native agent SDK' },
] as const;

export const MODEL_PROVIDER_OPTIONS = [
  { id: 'Bedrock', title: `Amazon Bedrock (${DEFAULT_MODEL_IDS.Bedrock})`, description: 'AWS managed model inference' },
  {
    id: 'Anthropic',
    title: `Anthropic (${DEFAULT_MODEL_IDS.Anthropic})`,
    description: 'Claude models via Anthropic API',
  },
  { id: 'OpenAI', title: `OpenAI (${DEFAULT_MODEL_IDS.OpenAI})`, description: 'GPT models via OpenAI API' },
  { id: 'Gemini', title: `Google Gemini (${DEFAULT_MODEL_IDS.Gemini})`, description: 'Gemini models via Google API' },
] as const;

/**
 * Get model provider options filtered by SDK framework compatibility.
 */
export function getModelProviderOptionsForSdk(sdk: SDKFramework) {
  const supportedProviders = getSupportedModelProviders(sdk);
  return MODEL_PROVIDER_OPTIONS.filter(option => supportedProviders.includes(option.id));
}

export const MEMORY_OPTIONS = [
  { id: 'none', title: 'None', description: 'No memory' },
  { id: 'shortTerm', title: 'Short-term memory', description: 'Context within a session' },
  { id: 'longAndShortTerm', title: 'Long-term and short-term', description: 'Persists across sessions' },
] as const;
