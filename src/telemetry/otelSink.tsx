import {
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { Logger } from "../logging";
import { type MetricSink } from "./types";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { type Histogram, type Meter } from "@opentelemetry/api";
import type { ResourceAttributes } from "./shapes";
import { AgentCoreCLIError } from "../errors";

export type OtelCollectorSinkConfig = {
  collectorEndpoint: string;
  logger: Logger;
  /** The resource attributes to attach to all metrics.**/
  resourceAttributes: ResourceAttributes;
  /** The time period between export flushes **/
  exportIntervalMs?: number;
  /** Describes the maximum time to wait when flushing metrics to the sink.**/
  flushTimeoutMs?: number;
  /** Describes the maximum time to wait when shutting down the sink.**/
  shutdownTimeoutMs?: number;
  /**
   * Describes the scope to attach to the given metrics. Defaults to `agentcore-cli`
   * See https://opentelemetry.io/docs/concepts/instrumentation-scope/ for more information.
   **/
  instrumentationScope?: string;
};

/**
 * An implementation of {@link MetricSink} that sends data to a collector using an otel histogram.
 */
export class OtelHistogramSink implements MetricSink {
  private readonly name: string;
  private readonly endpoint: string;
  private meterProvider: MeterProvider;
  private histograms: Map<string, Histogram>;
  private logger: Logger;

  private readonly flushTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly scopedMeter: Meter;

  constructor(config: OtelCollectorSinkConfig) {
    this.endpoint = config.collectorEndpoint;
    this.logger = config.logger.child({ telemetryEndpoint: config.collectorEndpoint });
    this.name = new.target.name;

    this.flushTimeoutMs = config.flushTimeoutMs ?? 500;
    this.shutdownTimeoutMs = config.shutdownTimeoutMs ?? 500;

    this.meterProvider = new MeterProvider({
      resource: resourceFromAttributes(config.resourceAttributes),
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: this.endpoint.endsWith("/v1/metrics")
              ? this.endpoint
              : `${this.endpoint}/v1/metrics`,
            headers: {
              "X-Installation-Id": config.resourceAttributes["agentcore-cli.installation_id"],
            },
            temporalityPreference: AggregationTemporality.DELTA,
          }),
          exportIntervalMillis: config.exportIntervalMs ?? 5_000,
        }),
      ],
    });
    this.scopedMeter = this.meterProvider.getMeter(config.instrumentationScope ?? "agentcore-cli");
    this.histograms = new Map<string, Histogram>();
  }

  private getHistogram(metricName: string): Histogram {
    if (!this.histograms.has(metricName)) {
      this.histograms.set(metricName, this.scopedMeter.createHistogram(metricName));
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
    try {
      await this.meterProvider.forceFlush({ timeoutMillis: this.flushTimeoutMs });
    } catch (e) {
      const error = AgentCoreCLIError.fromError(e);
      this.logger
        .child({ errorName: error.name, errorMessage: error.message })
        .warn(`failed to flush metrics to ${this.getName()}`);
      // don't let flush failures prevent shutdown
    }
    await this.meterProvider.shutdown({ timeoutMillis: this.shutdownTimeoutMs });
  }

  getName(): string {
    return this.name;
  }
}
