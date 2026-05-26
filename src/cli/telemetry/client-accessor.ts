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

  static init(entrypoint: string, mode: 'cli' | 'tui' = 'cli'): void {
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
    }
  }
}

async function createClient(entrypoint: string, mode: 'cli' | 'tui' = 'cli'): Promise<TelemetryClient> {
  const [resource, config] = await Promise.all([resolveResourceAttributes(mode), readGlobalConfig()]);

  const [{ enabled }, endpointResult, audit] = await Promise.all([
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

  if (endpointResult.success && enabled) {
    sinks.push(new OtelMetricSink({ endpoint: endpointResult.url, resource }));
  }

  return new TelemetryClient(new CompositeSink(sinks));
}
