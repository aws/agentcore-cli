import type { GatewayAuthorizerType } from '../../../schema';

// TODO: Extract TokenProvider interface when agent inbound auth ships.
// These plain functions (fetchGatewayToken, listGateways) are designed so
// a future TokenProvider interface can wrap them without breaking changes.

export interface TokenFetchResult {
  url: string;
  authType: GatewayAuthorizerType;
  token?: string;
  expiresIn?: number;
  message?: string;
}

export interface GatewayInfo {
  name: string;
  authType: GatewayAuthorizerType;
}
