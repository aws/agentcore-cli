import type { MetricAttrs, MetricName } from './schemas/registry.js';
import type { MetricSink } from './sinks/metric-sink.js';

/**
 * Generic metric emitter.
 */
export class TelemetryClient {
  constructor(private readonly sink: MetricSink) {}

  emit<M extends MetricName>(metricName: M, value: number, attrs: MetricAttrs<M>): void {
    try {
      const otelAttrs: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(attrs)) {
        if (typeof v === 'boolean') {
          otelAttrs[k] = String(v);
        } else if (typeof v === 'string' || typeof v === 'number') {
          otelAttrs[k] = v;
        }
      }
      this.sink.record(metricName, value, otelAttrs);
    } catch {
      // Telemetry must never affect CLI behavior
    }
  }

  async flush(): Promise<void> {
    try {
      await this.sink.flush();
    } catch {
      /* telemetry must not mask command errors */
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.sink.shutdown();
    } catch {
      /* telemetry must not affect CLI behavior */
    }
  }
}
