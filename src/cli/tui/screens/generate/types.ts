import type {
  BuildType,
  ModelProvider,
  NetworkMode,
  ProtocolMode,
  RuntimeAuthorizerType,
  SDKFramework,
  TargetLanguage,
} from '../../../../schema';
import { DEFAULT_MODEL_IDS, PROTOCOL_FRAMEWORK_MATRIX, getSupportedModelProviders } from '../../../../schema';
import type { JwtConfigOptions } from '../../../primitives/auth-utils';

export type GenerateStep =
  | 'projectName'
  | 'language'
  | 'buildType'
  | 'dockerfile'
  | 'protocol'
  | 'sdk'
  | 'modelProvider'
  | 'apiKey'
  | 'memory'
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
  | 'confirm';

export type MemoryOption = 'none' | 'shortTerm' | 'longAndShortTerm';

// Re-export types from schema for convenience
export type { BuildType, ModelProvider, ProtocolMode, SDKFramework, TargetLanguage };

export interface GenerateConfig {
  projectName: string;
  buildType: BuildType;
  /** Path to custom Dockerfile (copied into code directory at setup) or filename already in code directory. */
  dockerfile?: string;
  protocol: ProtocolMode;
  sdk: SDKFramework;
  modelProvider: ModelProvider;
  /** API key for non-Bedrock model providers (optional - can be added later) */
  apiKey?: string;
  memory: MemoryOption;
  language: TargetLanguage;
  networkMode?: NetworkMode;
  subnets?: string[];
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
}

/** Base steps - apiKey, memory, subnets, securityGroups are conditionally added based on selections */
export const BASE_GENERATE_STEPS: GenerateStep[] = [
  'projectName',
  'language',
  'buildType',
  'protocol',
  'sdk',
  'modelProvider',
  'apiKey',
  'advanced',
  'confirm',
];

export const STEP_LABELS: Record<GenerateStep, string> = {
  projectName: 'Name',
  language: 'Target Language',
  buildType: 'Build',
  dockerfile: 'Dockerfile',
  protocol: 'Protocol',
  sdk: 'Framework',
  modelProvider: 'Model',
  apiKey: 'API Key',
  memory: 'Memory',
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

export const PROTOCOL_OPTIONS = [
  { id: 'HTTP', title: 'HTTP', description: 'Standard HTTP agent (default)' },
  { id: 'MCP', title: 'MCP', description: 'Model Context Protocol tool server' },
  { id: 'A2A', title: 'A2A', description: 'Agent-to-Agent protocol' },
] as const;

export const SDK_OPTIONS = [
  { id: 'Strands', title: 'Strands Agents SDK', description: 'AWS native agent framework' },
  { id: 'LangChain_LangGraph', title: 'LangChain + LangGraph', description: 'Popular open-source frameworks' },
  { id: 'GoogleADK', title: 'Google ADK', description: 'Google Agent Development Kit' },
  { id: 'OpenAIAgents', title: 'OpenAI Agents', description: 'OpenAI native agent SDK' },
] as const;

/**
 * Get SDK options filtered by protocol compatibility.
 */
export function getSDKOptionsForProtocol(protocol: ProtocolMode) {
  const supportedFrameworks = PROTOCOL_FRAMEWORK_MATRIX[protocol];
  return SDK_OPTIONS.filter(option => supportedFrameworks.includes(option.id));
}

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

export const NETWORK_MODE_OPTIONS = [
  { id: 'PUBLIC', title: 'Public', description: undefined },
  { id: 'VPC', title: 'VPC', description: 'Attach to your VPC' },
] as const;

export type AdvancedSettingId = 'dockerfile' | 'network' | 'headers' | 'auth' | 'lifecycle' | 'filesystem';

export const ADVANCED_SETTING_OPTIONS = [
  { id: 'dockerfile', title: 'Custom Dockerfile', description: 'Specify a custom Dockerfile path' },
  { id: 'network', title: 'VPC networking', description: 'Attach to your VPC with subnets & security groups' },
  { id: 'headers', title: 'Request header allowlist', description: 'Allow custom headers through to your agent' },
  { id: 'auth', title: 'Custom auth (JWT)', description: 'OIDC-based token validation for inbound requests' },
  { id: 'lifecycle', title: 'Lifecycle timeouts', description: 'Idle timeout & max instance lifetime' },
  { id: 'filesystem', title: 'Session filesystem storage', description: 'Persist files across session stop/resume' },
] as const;

/** Dockerfile filename regex — must match the Zod schema in agent-env.ts */
const DOCKERFILE_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Validate a Dockerfile input value from the TUI.
 * Returns `true` if valid, or an error message string if invalid.
 * Does NOT check file existence for path inputs — callers handle that.
 */
export function validateDockerfileInput(value: string): true | string {
  const trimmed = value.trim();
  if (!trimmed) return true; // empty is valid (means "use default")
  if (trimmed.includes('/')) {
    // Path input — caller must check existsSync separately
    return true;
  }
  if (trimmed.length > 255) {
    return 'Dockerfile name must be 255 characters or fewer';
  }
  if (!DOCKERFILE_NAME_REGEX.test(trimmed)) {
    return 'Must be a valid filename (starts with alphanumeric)';
  }
  return true;
}

export const MEMORY_OPTIONS = [
  { id: 'none', title: 'None', description: 'No memory' },
  { id: 'shortTerm', title: 'Short-term memory', description: 'Context within a session' },
  { id: 'longAndShortTerm', title: 'Long-term and short-term', description: 'Persists across sessions' },
] as const;
