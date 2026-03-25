import { fetchGatewayToken, fetchRuntimeToken, listGateways } from '../../operations/fetch-access';
import type { OAuthTokenResult, TokenFetchResult } from '../../operations/fetch-access';
import type { FetchAccessOptions } from './types';

export interface FetchAccessResult {
  success: boolean;
  result?: TokenFetchResult;
  availableGateways?: { name: string; authType: string }[];
  error?: string;
}

export async function handleFetchAccess(options: FetchAccessOptions): Promise<FetchAccessResult> {
  const resourceType = options.type ?? 'gateway';

  if (resourceType === 'agent') {
    return handleFetchAgentAccess(options);
  }

  return handleFetchGatewayAccess(options);
}

async function handleFetchGatewayAccess(options: FetchAccessOptions): Promise<FetchAccessResult> {
  if (!options.name) {
    const gateways = await listGateways({ deployTarget: options.target });
    if (gateways.length === 0) {
      return { success: false, error: 'No deployed gateways found. Run `agentcore deploy` first.' };
    }
    return {
      success: false,
      error: 'Missing required option: --name',
      availableGateways: gateways,
    };
  }

  const result = await fetchGatewayToken(options.name, { deployTarget: options.target });
  return { success: true, result };
}

async function handleFetchAgentAccess(options: FetchAccessOptions): Promise<FetchAccessResult> {
  if (!options.name) {
    return { success: false, error: 'Missing required option: --name <agent>' };
  }

  let tokenResult: OAuthTokenResult;
  try {
    tokenResult = await fetchRuntimeToken(options.name, { deployTarget: options.target });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  return {
    success: true,
    result: {
      url: '',
      authType: 'CUSTOM_JWT',
      token: tokenResult.token,
      expiresIn: tokenResult.expiresIn,
    },
  };
}
