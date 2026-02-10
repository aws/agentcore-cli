import type { ModelProvider, PythonRuntime, SDKFramework, TargetLanguage } from '../../../../schema';
import { getSupportedModelProviders } from '../../../../schema';
import type { MemoryOption } from '../generate/types';

// ─────────────────────────────────────────────────────────────────────────────
// Add Agent Flow Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agent type selection: Create new agent code or bring existing code.
 */
export type AgentType = 'create' | 'byo';

/**
 * Add agent wizard steps.
 * - name: Agent name input
 * - agentType: Create new or bring your own code
 *
 * Create path (agentType = 'create'):
 * - language → framework → modelProvider → [apiKey] → memory → confirm
 *
 * BYO path (agentType = 'byo'):
 * - codeLocation → modelProvider → [apiKey] → confirm
 * (language/framework not needed for BYO - user's code already has these)
 *
 * Note: apiKey step only appears for non-Bedrock model providers
 */
export type AddAgentStep =
  | 'name'
  | 'agentType'
  | 'codeLocation'
  | 'language'
  | 'framework'
  | 'modelProvider'
  | 'apiKey'
  | 'memory'
  | 'confirm';

export interface AddAgentConfig {
  name: string;
  agentType: AgentType;
  /** Folder containing agent code, relative to project root (BYO only) */
  codeLocation: string;
  /** Entrypoint file, relative to codeLocation (BYO only) */
  entrypoint: string;
  language: TargetLanguage;
  framework: SDKFramework;
  modelProvider: ModelProvider;
  /** API key for non-Bedrock model providers (optional - can be added later) */
  apiKey?: string;
  /** Python version (only for Python agents) */
  pythonVersion: PythonRuntime;
  /** Memory option (create path only) */
  memory: MemoryOption;
}

export const ADD_AGENT_STEP_LABELS: Record<AddAgentStep, string> = {
  name: 'Name',
  agentType: 'Type',
  codeLocation: 'Code',
  language: 'Language',
  framework: 'Framework',
  modelProvider: 'Model',
  apiKey: 'API Key',
  memory: 'Memory',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// UI Option Constants
// ─────────────────────────────────────────────────────────────────────────────

export const AGENT_TYPE_OPTIONS = [
  { id: 'create', title: 'Create new agent' },
  { id: 'byo', title: 'Bring my own code' },
] as const;

export const LANGUAGE_OPTIONS = [
  { id: 'Python', title: 'Python' },
  { id: 'TypeScript', title: 'TypeScript (coming soon)', disabled: true },
  { id: 'Other', title: 'Other' },
] as const;

export const FRAMEWORK_OPTIONS = [
  { id: 'Strands', title: 'Strands Agents SDK', description: 'AWS native agent framework' },
  { id: 'LangChain_LangGraph', title: 'LangChain + LangGraph', description: 'Popular open-source frameworks' },
  { id: 'GoogleADK', title: 'Google ADK', description: 'Google Agent Development Kit' },
  { id: 'OpenAIAgents', title: 'OpenAI Agents', description: 'OpenAI native agent SDK' },
] as const;

export const MODEL_PROVIDER_OPTIONS = [
  { id: 'Bedrock', title: 'Amazon Bedrock', description: 'AWS managed model inference' },
  { id: 'Anthropic', title: 'Anthropic', description: 'Claude models via Anthropic API' },
  { id: 'OpenAI', title: 'OpenAI', description: 'GPT models via OpenAI API' },
  { id: 'Gemini', title: 'Google Gemini', description: 'Gemini models via Google API' },
] as const;

/**
 * Get model provider options filtered by SDK framework compatibility.
 */
export function getModelProviderOptionsForSdk(sdk: SDKFramework) {
  const supportedProviders = getSupportedModelProviders(sdk);
  return MODEL_PROVIDER_OPTIONS.filter(option => supportedProviders.includes(option.id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_PYTHON_VERSION: PythonRuntime = 'PYTHON_3_12';
export const DEFAULT_ENTRYPOINT = 'main.py';
