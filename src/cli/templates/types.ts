import type {
  BuildType,
  MemoryStrategyType,
  ModelProvider,
  ProtocolMode,
  SDKFramework,
  TargetLanguage,
} from '../../schema';

/**
 * Identity provider info for template rendering.
 */
export interface IdentityProviderRenderConfig {
  name: string;
  envVarName: string;
}

/**
 * Memory provider info for template rendering.
 */
export interface MemoryProviderRenderConfig {
  name: string;
  envVarName: string;
  /** Strategy types configured for this memory */
  strategies: MemoryStrategyType[];
}

/**
 * Gateway provider info for template rendering.
 */
export interface GatewayProviderRenderConfig {
  name: string;
  envVarName: string;
  authType: string; // AWS_IAM, CUSTOM_JWT, NONE
  /** Credential provider name for @requires_access_token (CUSTOM_JWT only) */
  credentialProviderName?: string;
  /** OIDC discovery URL for token endpoint lookup (CUSTOM_JWT only) */
  discoveryUrl?: string;
  /** Space-separated scopes for token request (CUSTOM_JWT only) */
  scopes?: string;
}

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
  hasGateway: boolean;
  /** Whether agent is deployed in VPC mode (affects example MCP endpoints) */
  isVpc: boolean;
  /** Build type: CodeZip (default) or Container */
  buildType?: BuildType;
  /** Memory providers for template rendering */
  memoryProviders: MemoryProviderRenderConfig[];
  /** Identity providers for template rendering (maps to credentials in schema) */
  identityProviders: IdentityProviderRenderConfig[];
  /** Gateway providers for template rendering */
  gatewayProviders: GatewayProviderRenderConfig[];
  /** Unique auth types across all gateways (for conditional imports) */
  gatewayAuthTypes: string[];
  /** Protocol (HTTP, MCP, A2A). Defaults to HTTP. */
  protocol?: ProtocolMode;
}
