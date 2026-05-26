import type { Result } from '../../lib/result.js';
import { type GlobalConfig, getOrCreateInstallationId, readGlobalConfig } from '../../lib/schemas/io/global-config.js';
import { PACKAGE_VERSION } from '../constants.js';
import { type ResourceAttributes, ResourceAttributesSchema } from './schemas/common-attributes.js';
import { randomUUID } from 'crypto';
import os from 'os';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Telemetry preference (opt-in / opt-out)
// ---------------------------------------------------------------------------

export interface TelemetryPreference {
  enabled: boolean;
  source: 'environment' | 'global-config' | 'default';
  envVar?: { name: string; value: string };
}

const ENV_VAR_NAME = 'AGENTCORE_TELEMETRY_DISABLED';

export async function resolveTelemetryPreference(config?: GlobalConfig): Promise<TelemetryPreference> {
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

  const resolved = config ?? (await readGlobalConfig());
  if (typeof resolved.telemetry?.enabled === 'boolean') {
    return { enabled: resolved.telemetry.enabled, source: 'global-config' };
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

export function resolveAuditFilePath(outputDir: string, entrypoint: string, sessionId: string): string {
  return join(outputDir, `${entrypoint}-${sessionId}.json`);
}

/**
 * Determine whether telemetry audit mode is enabled.
 * Audit mode writes all telemetry entries to a local file for inspection.
 */
export async function resolveAuditEnabled(config?: GlobalConfig): Promise<boolean> {
  if (process.env.AGENTCORE_TELEMETRY_AUDIT === '1') return true;
  const resolved = config ?? (await readGlobalConfig());
  return resolved.telemetry?.audit === true;
}

/**
 * Validate that a string is a well-formed HTTP(S) URL suitable for an OTLP endpoint.
 * Returns the normalized URL (trailing slashes stripped) on success.
 */
export function validateEndpointUrl(endpoint: string): Result<{ url: string }> {
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { success: false, error: new Error(`Unsupported protocol: ${parsed.protocol}`) };
    }
    return { success: true, url: parsed.origin + parsed.pathname.replace(/\/+$/, '') };
  } catch {
    return { success: false, error: new Error(`Invalid URL: ${endpoint}`) };
  }
}

/**
 * Resolve the telemetry endpoint from env var or global config.
 * Returns a failure Result if no endpoint is configured or the value is invalid.
 */
export async function resolveTelemetryEndpoint(config?: GlobalConfig): Promise<Result<{ url: string }>> {
  const envEndpoint = process.env.AGENTCORE_TELEMETRY_ENDPOINT;
  if (envEndpoint) {
    return validateEndpointUrl(envEndpoint);
  }
  const resolved = config ?? (await readGlobalConfig());
  const configEndpoint = resolved.telemetry?.endpoint;
  if (configEndpoint) {
    return validateEndpointUrl(configEndpoint);
  }
  return { success: false, error: new Error('No telemetry endpoint found.') };
}
