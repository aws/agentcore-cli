import { type Result, unwrapResult } from '../../lib/result.js';
import { type GlobalConfig, getOrCreateInstallationId, readGlobalConfig } from '../../lib/schemas/io/global-config.js';
import { PACKAGE_VERSION, TELEMETRY_ENDPOINT } from '../constants.js';
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

  const resolved = config ?? unwrapResult(await readGlobalConfig(), { config: {} }).config;
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
 */
export async function resolveResourceAttributes(
  mode: 'cli' | 'tui'
): Promise<Result<{ resource: ResourceAttributes }>> {
  const idResult = await getOrCreateInstallationId();
  if (!idResult.success) return idResult;
  const resource = ResourceAttributesSchema.parse({
    'service.name': 'agentcore-cli',
    'service.version': PACKAGE_VERSION,
    'agentcore-cli.installation_id': idResult.id,
    'agentcore-cli.session_id': randomUUID(),
    'agentcore-cli.mode': mode,
    'os.type': os.type(),
    'os.version': os.release(),
    'host.arch': os.arch(),
    'node.version': process.version,
  });
  return { success: true, resource };
}

export function resolveAuditFilePath(outputDir: string, entrypoint: string, sessionId: string): string {
  return join(outputDir, `${entrypoint}-${sessionId}.jsonl`);
}

/**
 * Determine whether telemetry audit mode is enabled.
 * Audit mode writes all telemetry entries to a local file for inspection.
 */
export async function resolveAuditEnabled(config?: GlobalConfig): Promise<boolean> {
  if (process.env.AGENTCORE_TELEMETRY_AUDIT === '1') return true;
  const resolved = config ?? unwrapResult(await readGlobalConfig(), { config: {} }).config;
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
 * Resolve the telemetry endpoint. Always returns a usable string.
 * Precedence: AGENTCORE_TELEMETRY_ENDPOINT env var > config.telemetry.endpoint > built-in default.
 */
export async function resolveTelemetryEndpoint(config?: GlobalConfig): Promise<string> {
  const envEndpoint = process.env.AGENTCORE_TELEMETRY_ENDPOINT;
  if (envEndpoint) {
    const validated = validateEndpointUrl(envEndpoint);
    if (validated.success) return validated.url;
  }
  const resolved = config ?? unwrapResult(await readGlobalConfig(), { config: {} }).config;
  const configEndpoint = resolved.telemetry?.endpoint;
  if (configEndpoint) {
    const validated = validateEndpointUrl(configEndpoint);
    if (validated.success) return validated.url;
  }
  return TELEMETRY_ENDPOINT;
}
