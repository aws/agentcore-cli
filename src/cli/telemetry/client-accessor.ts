import { unwrapResult } from '../../lib/result.js';
import { GLOBAL_CONFIG_DIR, readGlobalConfig } from '../../lib/schemas/io/global-config.js';
import { TelemetryClient } from './client.js';
import {
  resolveAuditEnabled,
  resolveAuditFilePath,
  resolveResourceAttributes,
  resolveTelemetryEndpoint,
  resolveTelemetryPreference,
} from './config.js';
import { FileSystemSink } from './sinks/filesystem-sink.js';
import { CompositeSink } from './sinks/metric-sink.js';
import { OtelMetricSink } from './sinks/otel-metric-sink.js';
import { join } from 'path';

/**
 * Manages a singleton TelemetryClient. Call init() at startup to configure,
 * get() from command handlers to obtain the client, and shutdown() on exit.
 * get() lazily initializes if init() was never called.
 */
export class TelemetryClientAccessor {
  private static clientPromise: Promise<TelemetryClient> | undefined;

  static async init(entrypoint: string, mode: 'cli' | 'tui' = 'cli'): Promise<void> {
    if (this.clientPromise) {
      await this.shutdown();
    }
    this.clientPromise = createClient(entrypoint, mode);
  }

  static get(): Promise<TelemetryClient> {
    this.clientPromise ??= createClient('unknown');
    return this.clientPromise;
  }

  static async shutdown(): Promise<void> {
    if (this.clientPromise) {
      try {
        const client = await this.clientPromise;
        await client.shutdown();
      } catch {
        // Telemetry is best-effort — don't propagate init or shutdown failures
      }
      this.clientPromise = undefined;
    }
  }
}

async function createClient(entrypoint: string, mode: 'cli' | 'tui' = 'cli'): Promise<TelemetryClient> {
  const [resourceResult, configResult] = await Promise.all([resolveResourceAttributes(mode), readGlobalConfig()]);
  if (!resourceResult.success) {
    // Could not resolve a stable installation id — disable telemetry rather than
    // emit metrics with an unstable id that breaks attribution across sessions.
    return new TelemetryClient(new CompositeSink([]));
  }
  const { resource } = resourceResult;
  const { config } = unwrapResult(configResult, { config: {} });

  const [{ enabled }, endpoint, audit] = await Promise.all([
    resolveTelemetryPreference(config),
    resolveTelemetryEndpoint(config),
    resolveAuditEnabled(config),
  ]);

  const sinks = [];

  if (audit) {
    const filePath = resolveAuditFilePath(
      join(GLOBAL_CONFIG_DIR, 'telemetry'),
      entrypoint,
      resource['agentcore-cli.session_id']
    );
    sinks.push(new FileSystemSink({ filePath, resource }));
  }

  if (enabled) {
    try {
      sinks.push(new OtelMetricSink({ endpoint, resource }));
    } catch {
      // Telemetry is best-effort — skip the network sink rather than crash.
    }
  }

  return new TelemetryClient(new CompositeSink(sinks));
}
