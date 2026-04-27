import type { ResourceAttributes } from '../schemas/common-attributes.js';
import type { MetricSink } from './metric-sink.js';
import type { Histogram } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { AggregationTemporality, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';

export interface OtelMetricSinkConfig {
  endpoint: string;
  resource: ResourceAttributes;
  exportIntervalMs?: number;
}

export class OtelMetricSink implements MetricSink {
  private readonly meterProvider: MeterProvider;
  private readonly histogram: Histogram;

  constructor(config: OtelMetricSinkConfig) {
    const resource = resourceFromAttributes(config.resource);
    const exporter = new OTLPMetricExporter({
      url: `${config.endpoint}/v1/metrics`,
      headers: { 'X-Installation-Id': config.resource['agentcore-cli.installation_id'] },
      temporalityPreference: AggregationTemporality.DELTA,
    });
    this.meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: config.exportIntervalMs ?? 60_000,
          exportTimeoutMillis: 5_000,
        }),
      ],
    });
    this.histogram = this.meterProvider
      .getMeter('agentcore-cli')
      .createHistogram('cli.command_run', { description: 'CLI command execution' });
  }

  record(value: number, attrs: Record<string, string | number>): void {
    this.histogram.record(value, attrs);
  }

  async flush(timeoutMs = 5_000): Promise<void> {
    await this.meterProvider.forceFlush({ timeoutMillis: timeoutMs });
  }

  async shutdown(): Promise<void> {
    await this.meterProvider.shutdown();
  }
}
