import type {
  DatasetSchemaType,
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
  efsAccessPointArn?: string[];
  efsMountPath?: string[];
  s3AccessPointArn?: string[];
  s3MountPath?: string[];
  capacityProvider?: string;
  cpVolumeName?: string[];
  cpVolumeMountPath?: string[];
  withConfigBundle?: boolean;
  json?: boolean;
}

// Gateway types
export interface AddGatewayOptions {
  name?: string;
  description?: string;
  protocolType?: string;
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
  outboundAuthType?: 'OAUTH' | 'API_KEY' | 'NONE' | 'GATEWAY_IAM_ROLE' | 'JWT_PASSTHROUGH';
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
  runtime?: string;
  runtimeEndpoint?: string;
  /** Connector id (for --type connector): bedrock-knowledge-bases | web-search. */
  connector?: string;
  /**
   * KB reference for --type connector — either a project KB name (entry in
   * knowledgeBases[]) or a literal 10-char external KB ID. Not applicable to
   * --connector web-search.
   */
  knowledgeBaseId?: string[];
  passthroughEndpoint?: string;
  stickinessIdentifier?: string;
  stickinessTimeout?: string;
  signingService?: string;
  signingRegion?: string;
  /**
   * Comma-separated list of domains to exclude from web search results.
   * Only applies to --type web-search.
   */
  excludeDomains?: string;
  json?: boolean;
}

// Harness types
export interface AddHarnessCliOptions {
  name?: string;
  modelProvider?: string;
  modelId?: string;
  apiFormat?: string;
  apiKeyArn?: string;
  container?: string;
  memory?: boolean;
  maxIterations?: number;
  maxTokens?: number;
  timeout?: number;
  truncationStrategy?: string;
  networkMode?: string;
  subnets?: string;
  securityGroups?: string;
  vpcId?: string;
  idleTimeout?: number;
  maxLifetime?: number;
  sessionStorage?: string;
  withInvokeScript?: boolean;
  systemPrompt?: string;
  tools?: string;
  mcpName?: string;
  mcpUrl?: string;
  gatewayArn?: string;
  gatewayOutboundAuth?: string;
  gatewayProviderArn?: string;
  gatewayScopes?: string;
  gatewayGrantType?: string;
  gatewayCustomParameters?: string;
  memoryMode?: string;
  memoryStrategies?: string;
  memoryEventExpiryDays?: number;
  memoryEncryptionKeyArn?: string;
  memoryName?: string;
  memoryArn?: string;
  memoryActorId?: string;
  memoryMessagesCount?: number;
  memoryTopK?: number;
  memoryRelevanceScore?: number;
  authorizerType?: RuntimeAuthorizerType;
  discoveryUrl?: string;
  allowedAudience?: string;
  allowedClients?: string;
  allowedScopes?: string;
  customClaims?: string;
  clientId?: string;
  clientSecret?: string;
  privateEndpointLatticeArn?: string;
  privateEndpointVpcId?: string;
  privateEndpointSubnets?: string;
  privateEndpointIpType?: string;
  privateEndpointSecurityGroups?: string;
  privateEndpointRoutingDomain?: string;
  privateEndpointTags?: string;
  privateEndpointOverrides?: string;
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
  indexedKey?: string[];
  json?: boolean;
}

// Dataset types
export interface AddDatasetOptions {
  name: string;
  schemaType: DatasetSchemaType;
  description?: string;
  kmsKeyArn?: string;
  json?: boolean;
}

export interface AddDatasetResult {
  success: boolean;
  datasetName?: string;
  error?: string;
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
