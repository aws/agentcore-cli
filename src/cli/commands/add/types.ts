import type { GatewayAuthorizerType, ModelProvider, ProtocolMode, SDKFramework, TargetLanguage } from '../../../schema';
import type { MemoryOption } from '../../tui/screens/generate/types';
import type { VpcOptions } from '../shared/vpc-utils';

// Agent types
export interface AddAgentOptions extends VpcOptions {
  name?: string;
  type?: 'create' | 'byo';
  build?: string;
  language?: TargetLanguage;
  framework?: SDKFramework;
  modelProvider?: ModelProvider;
  apiKey?: string;
  memory?: MemoryOption;
  protocol?: ProtocolMode;
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
  allowedScopes?: string;
  agentClientId?: string;
  agentClientSecret?: string;
  agents?: string;
  semanticSearch?: boolean;
  exceptionLevel?: string;
  json?: boolean;
}

export interface AddGatewayResult {
  success: boolean;
  gatewayName?: string;
  error?: string;
}

// Gateway Target types
export interface AddGatewayTargetOptions {
  name?: string;
  description?: string;
  type?: string;
  endpoint?: string;
  language?: 'Python' | 'TypeScript' | 'Other';
  gateway?: string;
  host?: 'Lambda' | 'AgentCoreRuntime';
  outboundAuthType?: 'OAUTH' | 'API_KEY' | 'NONE';
  credentialName?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthDiscoveryUrl?: string;
  oauthScopes?: string;
  restApiId?: string;
  stage?: string;
  lambdaArn?: string;
  toolSchemaFile?: string;
  toolFilterPath?: string;
  toolFilterMethods?: string;
  schema?: string;
  schemaS3Account?: string;
  json?: boolean;
}

export interface AddGatewayTargetResult {
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
  type?: 'api-key' | 'oauth';
  apiKey?: string;
  discoveryUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  json?: boolean;
}

export interface AddIdentityResult {
  success: boolean;
  credentialName?: string;
  error?: string;
}
