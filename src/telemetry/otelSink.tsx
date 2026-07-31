import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { Logger } from "../logging";
import type { MetricSink } from "./types";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { type Histogram } from "@opentelemetry/api";
import type { ResourceAttributes } from "./shapes";

export type OtelCollectorSinkConfig = {
  endpoint: string;
  logger: Logger;
  resourceAttributes: ResourceAttributes;
  exportIntervalMs?: number;
  flushTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  instrumentationScope?: string;
};

export class OtelHistogramSink implements MetricSink {
  private readonly name: string;
  private readonly endpoint: string;
  private meterProvider: MeterProvider;
  private histograms: Map<string, Histogram>;
  private logger: Logger;

  private readonly flushTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly instrumentationScope: string;

  constructor(config: OtelCollectorSinkConfig) {
    this.endpoint = config.endpoint;
    this.logger = config.logger.child({ telemetryEndpoint: config.endpoint });
    this.name = new.target.name;

    this.flushTimeoutMs = config.flushTimeoutMs ?? 50;
    this.shutdownTimeoutMs = config.shutdownTimeoutMs ?? 50;
    this.instrumentationScope = config.instrumentationScope ?? "agentcore-cli";

    this.meterProvider = new MeterProvider({
      resource: resourceFromAttributes(config.resourceAttributes),
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: this.endpoint.endsWith("/v1/metrics")
              ? this.endpoint
              : `${this.endpoint}/v1/metrics`,
          }),
          exportIntervalMillis: config.exportIntervalMs ?? 5_000,
        }),
      ],
    });

    this.histograms = new Map<string, Histogram>();
  }

  private getHistogram(metricName: string): Histogram {
    if (!this.histograms.has(metricName)) {
      this.histograms.set(
        metricName,
        this.meterProvider.getMeter(this.instrumentationScope).createHistogram(metricName),
      );
    }
    return this.histograms.get(metricName)!;
  }

  send(metricName: string, value: number, attributes: Record<string, string | number>): void {
    this.logger
      .child({ metricName, metricValue: value, metricAttributes: attributes })
      .info(`sending telemetry metric to collector`);

    this.getHistogram(metricName).record(value, attributes);
  }

  async shutdown(): Promise<void> {
    await this.meterProvider.forceFlush({ timeoutMillis: this.flushTimeoutMs });
    await this.meterProvider.shutdown({ timeoutMillis: this.shutdownTimeoutMs });
  }

  getName(): string {
    return this.name;
  }
}
