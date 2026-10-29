import { ConfigIO, findConfigRoot, readEnvFile } from '../../../lib';
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
  const targetRegionEnvVars = await getTargetRegionEnvVars(configRoot);

  return {
    envVars: { ...gatewayEnvVars, ...memoryEnvVars, ...paymentEnvVars, ...dotEnvVars, ...targetRegionEnvVars },
    deployedMemoryCount: Object.keys(memoryEnvVars).length,
  };
}

/**
 * Make the first configured deployment target's region authoritative for local dev.
 * AgentCore SDK clients in a local runtime resolve their region from the environment,
 * so inheriting a different shell or .env region can point them at the wrong resources.
 */
async function getTargetRegionEnvVars(configRoot: string | null): Promise<Record<string, string>> {
  if (!configRoot) return {};

  try {
    const targets = await new ConfigIO({ baseDir: configRoot }).readAWSDeploymentTargets();
    const region = targets[0]?.region;
    return region ? { AWS_REGION: region, AWS_DEFAULT_REGION: region } : {};
  } catch {
    // A project may not have a deployment target before its first deploy.
    return {};
  }
}
