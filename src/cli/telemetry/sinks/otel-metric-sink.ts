import type { ResourceAttributes } from '../schemas/common-attributes.js';
import { METRICS, type MetricName } from '../schemas/registry.js';
import type { MetricSink } from './metric-sink.js';
import type { Histogram, Meter } from '@opentelemetry/api';
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
  private readonly meter: Meter;
  private readonly histograms = new Map<string, Histogram>();

  constructor(config: OtelMetricSinkConfig) {
    const resource = resourceFromAttributes(config.resource);
    const url = config.endpoint.endsWith('/v1/metrics') ? config.endpoint : `${config.endpoint}/v1/metrics`;
    const exporter = new OTLPMetricExporter({
      url,
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
    this.meter = this.meterProvider.getMeter('agentcore-cli');
  }

  record(metricName: MetricName, value: number, attrs: Record<string, string | number>): void {
    let histogram = this.histograms.get(metricName);
    if (!histogram) {
      histogram = this.meter.createHistogram(metricName, { description: METRICS[metricName].description });
      this.histograms.set(metricName, histogram);
    }
    histogram.record(value, attrs);
  }

  async flush(timeoutMs = 5_000): Promise<void> {
    await this.meterProvider.forceFlush({ timeoutMillis: timeoutMs });
  }

  async shutdown(): Promise<void> {
    await this.meterProvider.shutdown();
  }
}
