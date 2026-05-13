import type { Result } from '../../../lib/result';
import { readGlobalConfigSync } from '../../../lib/schemas/io/global-config';
import { enableTransactionSearch } from '../../aws/transaction-search';

export interface TransactionSearchSetupOptions {
  region: string;
  accountId: string;
  agentNames: string[];
  hasGateways?: boolean;
}

/**
 * Post-deploy step: enable CloudWatch Transaction Search (Application Signals +
 * resource policy + CloudWatchLogs destination + 100% indexing).
 * All operations are idempotent.
 *
 * Can be disabled via ~/.agentcore/config.json: { "disableTransactionSearch": true }
 *
 * This is a non-blocking best-effort operation — failures do not fail the deploy.
 */
export async function setupTransactionSearch(options: TransactionSearchSetupOptions): Promise<Result> {
  const { region, accountId, agentNames } = options;

  if (agentNames.length === 0 && !options.hasGateways) {
    return { success: true };
  }

  const config = readGlobalConfigSync();
  if (config.disableTransactionSearch) {
    return { success: true };
  }

  const indexPercentage = config.transactionSearchIndexPercentage ?? 100;
  const result = await enableTransactionSearch(region, accountId, indexPercentage);

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return { success: true };
}
