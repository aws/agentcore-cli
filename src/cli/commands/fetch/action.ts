import { fetchGatewayToken, listGateways } from '../../operations/fetch-access';
import type { TokenFetchResult } from '../../operations/fetch-access';
import type { FetchAccessOptions } from './types';

export interface FetchAccessResult {
  success: boolean;
  result?: TokenFetchResult;
  availableGateways?: { name: string; authType: string }[];
  error?: string;
}

export async function handleFetchAccess(options: FetchAccessOptions): Promise<FetchAccessResult> {
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
