import type {
  GatewayAuthorizerType,
  ModelProvider,
  ProtocolMode,
  RuntimeAuthorizerType,
  SDKFramework,
  TargetLanguage,
} from '../../../schema';
import type { MemoryOption } from '../../tui/screens/generate/types';
import type { VpcOptions } from '../shared/vpc-utils';

// Agent types
export interface AddAgentOptions extends VpcOptions {
  name?: string;
  type?: 'create' | 'byo' | 'import';
  build?: string;
  language?: TargetLanguage;
  framework?: SDKFramework;
  modelProvider?: ModelProvider;
  apiKey?: string;
  memory?: MemoryOption;
  protocol?: ProtocolMode;
  codeLocation?: string;
  entrypoint?: string;
  agentId?: string;
  agentAliasId?: string;
  region?: string;
  authorizerType?: RuntimeAuthorizerType;
  discoveryUrl?: string;
  allowedAudience?: string;
  allowedClients?: string;
  allowedScopes?: string;
  customClaims?: string;
  clientId?: string;
  clientSecret?: string;
  requestHeaderAllowlist?: string;
  idleTimeout?: number | string;
  maxLifetime?: number | string;
  sessionStorageMountPath?: string;
  withConfigBundle?: boolean;
  json?: boolean;
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
  customClaims?: string;
  clientId?: string;
  clientSecret?: string;
  runtimes?: string;
  semanticSearch?: boolean;
  exceptionLevel?: string;
  policyEngine?: string;
  policyEngineMode?: string;
  json?: boolean;
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

// Memory types (v2: no owner/user concept)
export interface AddMemoryOptions {
  name?: string;
  strategies?: string;
  expiry?: number;
  deliveryType?: string;
  dataStreamArn?: string;
  contentLevel?: string;
  streamDeliveryResources?: string;
  json?: boolean;
}

// Credential types (v2: credential, no owner/user concept)
export interface AddCredentialOptions {
  name?: string;
  type?: 'api-key' | 'oauth';
  apiKey?: string;
  discoveryUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  json?: boolean;
}

/** @deprecated Use AddCredentialOptions */
export type AddIdentityOptions = AddCredentialOptions;
