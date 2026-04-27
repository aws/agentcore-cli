import { findConfigRoot, readEnvFile } from '../../../lib';
import { getGatewayEnvVars } from './gateway-env.js';
import { getMemoryEnvVars } from './memory-env.js';

export interface DevEnv {
  /** Merged env vars: deployed-state (gateway + memory) first, then .env overrides */
  envVars: Record<string, string>;
  /** Number of deployed memories (based on env vars resolved from deployed state) */
  deployedMemoryCount: number;
}

/**
 * Load all dev-mode environment variables: deployed-state gateway/memory env vars
 * merged with the user's .env file. Deployed-state vars go first so .env can override.
 */
export async function loadDevEnv(workingDir: string): Promise<DevEnv> {
  const configRoot = findConfigRoot(workingDir);
  const dotEnvVars = configRoot ? await readEnvFile(configRoot) : {};
  const gatewayEnvVars = await getGatewayEnvVars();
  const memoryEnvVars = await getMemoryEnvVars();

  return {
    envVars: { ...gatewayEnvVars, ...memoryEnvVars, ...dotEnvVars },
    deployedMemoryCount: Object.keys(memoryEnvVars).length,
  };
}
