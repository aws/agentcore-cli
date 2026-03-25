import type { GatewayAuthorizerType, RuntimeAuthorizerType } from '../../../schema';

export type FetchResourceType = 'gateway' | 'agent';

export interface TokenFetchResult {
  url: string;
  authType: GatewayAuthorizerType | RuntimeAuthorizerType | 'CUSTOM_JWT';
  token?: string;
  expiresIn?: number;
  message?: string;
}

export interface GatewayInfo {
  name: string;
  authType: GatewayAuthorizerType;
}

export interface AgentInfo {
  name: string;
  authType: RuntimeAuthorizerType;
}

export interface ResourceInfo {
  name: string;
  resourceType: FetchResourceType;
  authType: string;
}
