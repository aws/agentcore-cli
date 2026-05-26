import type {
  BuildType,
  ModelProvider,
  NetworkMode,
  ProtocolMode,
  PythonRuntime,
  RuntimeAuthorizerType,
  SDKFramework,
  TargetLanguage,
} from '../../../../schema';
import { DEFAULT_MODEL_IDS, getSupportedModelProviders } from '../../../../schema';
import type { JwtConfigOptions } from '../../../primitives/auth-utils';
import type { MemoryOption } from '../generate/types';

// ─────────────────────────────────────────────────────────────────────────────
// Add Agent Flow Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agent type selection: Create new agent code or bring existing code.
 */
export type AgentType = 'create' | 'byo' | 'import';

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
  | 'buildType'
  | 'dockerfile'
  | 'language'
  | 'protocol'
  | 'framework'
  | 'modelProvider'
  | 'apiKey'
  | 'advanced'
  | 'networkMode'
  | 'subnets'
  | 'securityGroups'
  | 'requestHeaderAllowlist'
  | 'authorizerType'
  | 'jwtConfig'
  | 'idleTimeout'
  | 'maxLifetime'
  | 'sessionStorageMountPath'
  | 'memory'
  | 'region'
  | 'bedrockAgent'
  | 'bedrockAlias'
  | 'confirm';

export interface AddAgentConfig {
  name: string;
  agentType: AgentType;
  /** Folder containing agent code, relative to project root (BYO only) */
  codeLocation: string;
  /** Entrypoint file, relative to codeLocation (BYO only) */
  entrypoint: string;
  language: TargetLanguage;
  buildType: BuildType;
  /** Path to custom Dockerfile (copied into code directory at setup) or filename already in code directory. */
  dockerfile?: string;
  /** Protocol (HTTP, MCP, A2A, AGUI). Defaults to HTTP. */
  protocol: ProtocolMode;
  framework: SDKFramework;
  modelProvider: ModelProvider;
  /** API key for non-Bedrock model providers (optional - can be added later) */
  apiKey?: string;
  /** Network mode for the runtime */
  networkMode?: NetworkMode;
  /** Subnet IDs for VPC mode */
  subnets?: string[];
  /** Security group IDs for VPC mode */
  securityGroups?: string[];
  /** Allowed request headers for the runtime */
  requestHeaderAllowlist?: string[];
  /** Authorizer type for inbound requests */
  authorizerType?: RuntimeAuthorizerType;
  /** JWT config for CUSTOM_JWT authorizer */
  jwtConfig?: JwtConfigOptions;
  /** Idle session timeout in seconds (LIFECYCLE_TIMEOUT_MIN-LIFECYCLE_TIMEOUT_MAX) */
  idleRuntimeSessionTimeout?: number;
  /** Max instance lifetime in seconds (LIFECYCLE_TIMEOUT_MIN-LIFECYCLE_TIMEOUT_MAX) */
  maxLifetime?: number;
  /** Mount path for session filesystem storage (e.g. /mnt/session-storage) */
  sessionStorageMountPath?: string;
  /** When true, create a config bundle wired into the agent template */
  withConfigBundle?: boolean;
  /** Python version (only for Python agents) */
  pythonVersion: PythonRuntime;
  /** Memory option (create path only) */
  memory: MemoryOption;
  /** Bedrock Agent ID (import path only) */
  bedrockAgentId?: string;
  /** Bedrock Agent Alias ID (import path only) */
  bedrockAliasId?: string;
  /** AWS region for Bedrock Agent (import path only) */
  bedrockRegion?: string;
}

export const ADD_AGENT_STEP_LABELS: Record<AddAgentStep, string> = {
  name: 'Name',
  agentType: 'Type',
  codeLocation: 'Code',
  buildType: 'Build',
  dockerfile: 'Dockerfile',
  language: 'Language',
  protocol: 'Protocol',
  framework: 'Framework',
  modelProvider: 'Model',
  apiKey: 'API Key',
  advanced: 'Advanced',
  networkMode: 'Network',
  subnets: 'Subnets',
  securityGroups: 'Security Groups',
  requestHeaderAllowlist: 'Headers',
  authorizerType: 'Auth',
  jwtConfig: 'JWT Config',
  idleTimeout: 'Idle Timeout',
  maxLifetime: 'Max Lifetime',
  sessionStorageMountPath: 'Session Storage',
  memory: 'Memory',
  region: 'Region',
  bedrockAgent: 'Agent',
  bedrockAlias: 'Alias',
  confirm: 'Confirm',
};

export const RUNTIME_AUTHORIZER_TYPE_OPTIONS = [
  { id: 'AWS_IAM', title: 'AWS IAM (default)', description: 'Standard AWS IAM authentication' },
  { id: 'CUSTOM_JWT', title: 'Custom JWT', description: 'OIDC-based token validation for inbound requests' },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// UI Option Constants
// ─────────────────────────────────────────────────────────────────────────────

export const AGENT_TYPE_OPTIONS = [
  { id: 'create', title: 'Create new agent' },
  { id: 'byo', title: 'Bring my own code' },
  { id: 'import', title: 'Import from Bedrock Agents' },
] as const;

export const LANGUAGE_OPTIONS = [
  { id: 'Python', title: 'Python' },
  { id: 'TypeScript', title: 'TypeScript' },
  { id: 'Other', title: 'Other' },
] as const;

export const FRAMEWORK_OPTIONS = [
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

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

export const NETWORK_MODE_OPTIONS = [
  { id: 'PUBLIC', title: 'Public', description: undefined },
  { id: 'VPC', title: 'VPC', description: 'Attach to your VPC' },
] as const;

export { DEFAULT_PYTHON_VERSION } from '../../../../schema';
export const DEFAULT_ENTRYPOINT = 'main.py';
