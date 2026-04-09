import { readGlobalConfig } from '../global-config.js';

export interface TelemetryPreference {
  enabled: boolean;
  source: 'environment' | 'global-config' | 'default';
  envVar?: { name: string; value: string };
}

const ENV_VAR_NAME = 'AGENTCORE_TELEMETRY_DISABLED';

export async function resolveTelemetryPreference(configFile?: string): Promise<TelemetryPreference> {
  const agentcoreEnv = process.env[ENV_VAR_NAME];
  if (agentcoreEnv !== undefined) {
    const normalized = agentcoreEnv.toLowerCase().trim();
    if (normalized === 'false' || normalized === '0') {
      return { enabled: true, source: 'environment', envVar: { name: ENV_VAR_NAME, value: agentcoreEnv } };
    }
    if (normalized !== '') {
      return { enabled: false, source: 'environment', envVar: { name: ENV_VAR_NAME, value: agentcoreEnv } };
    }
  }

  const config = await readGlobalConfig(configFile);
  if (typeof config.telemetry?.enabled === 'boolean') {
    return { enabled: config.telemetry.enabled, source: 'global-config' };
  }

  return { enabled: true, source: 'default' };
}
