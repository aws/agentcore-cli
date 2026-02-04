import type { GatewayAuthorizerType, ModelProvider, SDKFramework, TargetLanguage } from '../../../schema';
import type { MemoryOption } from '../../tui/screens/generate/types';

// Agent types
export interface AddAgentOptions {
  name?: string;
  type?: 'create' | 'byo';
  language?: TargetLanguage;
  framework?: SDKFramework;
  modelProvider?: ModelProvider;
  apiKey?: string;
  memory?: MemoryOption;
  codeLocation?: string;
  entrypoint?: string;
  json?: boolean;
}

export interface AddAgentResult {
  success: boolean;
  agentName?: string;
  agentPath?: string;
  error?: string;
}

// Gateway types
export interface AddGatewayOptions {
  name?: string;
  description?: string;
  authorizerType?: GatewayAuthorizerType;
  discoveryUrl?: string;
  allowedAudience?: string;
  allowedClients?: string;
  agents?: string;
  json?: boolean;
}

export interface AddGatewayResult {
  success: boolean;
  gatewayName?: string;
  error?: string;
}

// MCP Tool types
export interface AddMcpToolOptions {
  name?: string;
  description?: string;
  language?: 'Python' | 'TypeScript' | 'Other';
  exposure?: 'mcp-runtime' | 'behind-gateway';
  agents?: string;
  gateway?: string;
  host?: 'Lambda' | 'AgentCoreRuntime';
  json?: boolean;
}

export interface AddMcpToolResult {
  success: boolean;
  toolName?: string;
  sourcePath?: string;
  error?: string;
}

// Memory types
export interface AddMemoryOptions {
  name?: string;
  description?: string;
  strategies?: string;
  expiry?: number;
  owner?: string;
  users?: string;
  json?: boolean;
}

export interface AddMemoryResult {
  success: boolean;
  memoryName?: string;
  ownerAgent?: string;
  userAgents?: string[];
  error?: string;
}

// Identity types
export interface AddIdentityOptions {
  name?: string;
  type?: string;
  apiKey?: string;
  owner?: string;
  users?: string;
  json?: boolean;
}

export interface AddIdentityResult {
  success: boolean;
  identityName?: string;
  ownerAgent?: string;
  userAgents?: string[];
  error?: string;
}

// Bind types (for --bind flag)
export interface BindMemoryOptions {
  agent: string;
  memory: string;
  access?: 'read' | 'readwrite';
  envVar?: string;
  json?: boolean;
}

export interface BindMemoryResult {
  success: boolean;
  memoryName?: string;
  targetAgent?: string;
  error?: string;
}

export interface BindIdentityOptions {
  agent: string;
  identity: string;
  envVar?: string;
  json?: boolean;
}

export interface BindIdentityResult {
  success: boolean;
  identityName?: string;
  targetAgent?: string;
  error?: string;
}

export interface BindGatewayOptions {
  agent: string;
  gateway: string;
  name?: string;
  description?: string;
  envVar?: string;
  json?: boolean;
}

export interface BindGatewayResult {
  success: boolean;
  gatewayName?: string;
  targetAgent?: string;
  error?: string;
}

export interface BindMcpRuntimeOptions {
  agent: string;
  runtime: string;
  envVar?: string;
  json?: boolean;
}

export interface BindMcpRuntimeResult {
  success: boolean;
  runtimeName?: string;
  targetAgent?: string;
  error?: string;
}

export interface BindAgentOptions {
  source: string;
  target: string;
  name?: string;
  description?: string;
  envVar?: string;
  json?: boolean;
}

export interface BindAgentResult {
  success: boolean;
  toolName?: string;
  sourceAgent?: string;
  targetAgent?: string;
  error?: string;
}
