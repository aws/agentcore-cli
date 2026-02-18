import type { GatewayAuthorizerType, ModelProvider, SDKFramework, TargetLanguage } from '../../../schema';
import type { MemoryOption } from '../../tui/screens/generate/types';

// Agent types
export interface AddAgentOptions {
  name?: string;
  type?: 'create' | 'byo';
  build?: string;
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

// Memory types (v2: no owner/user concept)
export interface AddMemoryOptions {
  name?: string;
  strategies?: string;
  expiry?: number;
  json?: boolean;
}

export interface AddMemoryResult {
  success: boolean;
  memoryName?: string;
  error?: string;
}

// Identity types (v2: credential, no owner/user concept)
export interface AddIdentityOptions {
  name?: string;
  apiKey?: string;
  json?: boolean;
}

export interface AddIdentityResult {
  success: boolean;
  credentialName?: string;
  error?: string;
}
