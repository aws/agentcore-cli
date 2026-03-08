import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_FILE = join(homedir(), '.agentcore', 'config.json');

export interface CliConfig {
  uvDefaultIndex?: string;
  uvIndex?: string;
  disableTransactionSearch?: boolean;
  transactionSearchIndexPercentage?: number;
}

/**
 * Read the global CLI config from ~/.agentcore/config.json.
 * Returns an empty object if the file doesn't exist or is malformed.
 */
export function readCliConfig(): CliConfig {
  try {
    const data = readFileSync(CONFIG_FILE, 'utf-8');
    const parsed: Record<string, unknown> = JSON.parse(data) as Record<string, unknown>;
    const config: CliConfig = {};
    if (typeof parsed.uvDefaultIndex === 'string') config.uvDefaultIndex = parsed.uvDefaultIndex;
    if (typeof parsed.uvIndex === 'string') config.uvIndex = parsed.uvIndex;
    if (parsed.disableTransactionSearch === true) config.disableTransactionSearch = true;
    if (typeof parsed.transactionSearchIndexPercentage === 'number') {
      const pct = parsed.transactionSearchIndexPercentage;
      if (pct >= 0 && pct <= 100) {
        config.transactionSearchIndexPercentage = pct;
      }
    }
    return config;
  } catch {
    return {};
  }
}
