import { findConfigRoot, readEnvFile } from '../../../lib';
import type { AgentEnvSpec } from '../../../schema';
import { getGatewayEnvVars } from './gateway-env.js';
import { getMemoryEnvVars } from './memory-env.js';
import { getPaymentEnvVars } from './payment-env.js';

export interface DevEnv {
  /** Merged env vars: deployed-state (gateway + memory + payment) first, then .env overrides */
  envVars: Record<string, string>;
  /** Number of deployed memories (based on env vars resolved from deployed state) */
  deployedMemoryCount: number;
}

/**
 * Load all dev-mode environment variables: deployed-state gateway/memory/payment env vars
 * merged with the user's .env file. Deployed-state vars go first so .env can override.
 *
 * @param runtime The runtime being launched. When provided, payment env vars
 * are only injected for runtimes that can consume them (Python HTTP today).
 */
export async function loadDevEnv(workingDir: string, runtime?: AgentEnvSpec): Promise<DevEnv> {
  const configRoot = findConfigRoot(workingDir);
  const dotEnvVars = configRoot ? await readEnvFile(configRoot) : {};
  const gatewayEnvVars = await getGatewayEnvVars();
  const memoryEnvVars = await getMemoryEnvVars();
  const paymentEnvVars = await getPaymentEnvVars(runtime);

  return {
    envVars: { ...gatewayEnvVars, ...memoryEnvVars, ...paymentEnvVars, ...dotEnvVars },
    deployedMemoryCount: Object.keys(memoryEnvVars).length,
  };
}
