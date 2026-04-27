import { PACKAGE_VERSION } from '../constants.js';
import { getOrCreateInstallationId, readGlobalConfig } from '../global-config.js';
import { type ResourceAttributes, ResourceAttributesSchema } from './schemas/common-attributes.js';
import { randomUUID } from 'crypto';
import os from 'os';

// ---------------------------------------------------------------------------
// Telemetry preference (opt-in / opt-out)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Resource attributes (per-session OTel metadata)
// ---------------------------------------------------------------------------

/**
 * Resolve and validate resource attributes for the current session.
 * Called once at startup — the returned object is reused for every metric in the session.
 * Throws if any attribute fails validation (prevents PII leakage).
 */
export async function resolveResourceAttributes(mode: 'cli' | 'tui'): Promise<ResourceAttributes> {
  const { id } = await getOrCreateInstallationId();
  return ResourceAttributesSchema.parse({
    'service.name': 'agentcore-cli',
    'service.version': PACKAGE_VERSION,
    'agentcore-cli.installation_id': id,
    'agentcore-cli.session_id': randomUUID(),
    'agentcore-cli.mode': mode,
    'os.type': os.type(),
    'os.version': os.release(),
    'host.arch': os.arch(),
    'node.version': process.version,
  });
}
