import type { Logger } from "../logging";
import { resourceAttributesSchema, type ResourceAttributes } from "./shapes";
import os from "os";
import {
  type AttributesOf,
  type MetricSink,
  type TelemetryClient,
  type ValueOf,
  METRICS,
  type MetricName,
  type MetricEvent,
} from "./types";
import type { GlobalConfigAccessor } from "../globalConfig";
import { FileSystemSink } from "./fileSystemSink";
import path from "path";
import { OtelHistogramSink } from "./otelSink";
import { isChinaContext } from "../core/partition";
import { regionFlagFromArgv, resolveRegion } from "../core/region";

export type DefaultTelemetryClientConfig = {
  logger: Logger;
  globalConfigAccessor: GlobalConfigAccessor;
  sessionId: string;
  metricSinks?: MetricSink[];
  auditFilePath?: string;
  /** Raw process argv, used to honor an explicit --region for the China telemetry gate. */
  argv?: readonly string[];
  currentVersion: string;
};

/**
 * Implements {@link TelemetryClient} by validating and fanning out metrics to a list of {@link MetricSink} implementations.
 */
export class DefaultTelemetryClient implements TelemetryClient {
  private logger: Logger;
  private readonly sessionId: string;
  private readonly auditFilePath: string;
  private globalConfigAccessor: GlobalConfigAccessor;
  private readonly metricSinksOverride: MetricSink[] | undefined;
  private readonly argv: readonly string[];
  private readonly currentVersion: string;

  constructor(config: DefaultTelemetryClientConfig) {
    this.logger = config.logger;
    this.sessionId = config.sessionId;
    this.globalConfigAccessor = config.globalConfigAccessor;
    this.metricSinksOverride = config.metricSinks;
    this.argv = config.argv ?? [];
    this.currentVersion = config.currentVersion;
    this.auditFilePath =
      config.auditFilePath ??
      path.join(os.homedir(), ".agentcore", "telemetry", `${this.sessionId}.jsonl`);
  }

  createMetricEvent<TMetricName extends MetricName>(
    metricName: TMetricName,
    initialAttributes: Partial<AttributesOf<TMetricName>> = {},
  ): MetricEvent<TMetricName> {
    return new InMemoryMetricEvent({
      metricName,
      initialAttributes,
      logger: this.logger,
      getSinks: () => this.getMetricSinks(),
    });
  }

  async shutdown(): Promise<void> {
    const metricSinks = await this.getMetricSinks();

    const promises = metricSinks.map(async (sink) => {
      return sink.shutdown().catch((e) => {
        const error = e instanceof Error ? e : new Error(String(e));
        this.logger
          .child({ errorName: error.name, errorMessage: error.message })
          .warn(`failed to shutdown metric sink with name '${sink.getName()}'`);
      });
    });
    await Promise.all(promises);
  }

  private getMetricSinks: () => Promise<MetricSink[]> = once(async () => {
    if (this.metricSinksOverride) return this.metricSinksOverride;
    const resourceAttributes = await this.getResourceAttributes();

    const metricSinks = [];

    const globalConfig = await this.globalConfigAccessor.get();

    if (globalConfig.telemetry.audit)
      metricSinks.push(
        new FileSystemSink({
          logger: this.logger.child({ module: "fileSystemSink" }),
          filePath: this.auditFilePath,
          resourceAttributes,
        }),
      );

    // Telemetry is unconditionally disabled in a China (aws-cn) context —
    // regardless of config or endpoint overrides — to comply with the
    // restrictions on sending telemetry out of the region. The region is
    // resolved through the same chain the CLI itself uses (--region flag, env
    // vars, shared config file). The audit file sink above is unaffected (it
    // only writes locally).
    const resolvedRegion = await resolveRegion(regionFlagFromArgv(this.argv));
    if (
      globalConfig.telemetry.enabled &&
      !telemetryDisabledByEnv() &&
      !(await isChinaContext({ region: resolvedRegion }))
    )
      metricSinks.push(
        new OtelHistogramSink({
          logger: this.logger.child({ module: "otelCollectorSink" }),
          collectorEndpoint: globalConfig.telemetry.endpoint,
          resourceAttributes,
        }),
      );

    return metricSinks;
  });

  private getResourceAttributes: () => Promise<ResourceAttributes> = once(async () => {
    const globalConfig = await this.globalConfigAccessor.get();
    return resourceAttributesSchema.parse({
      "service.name": "agentcore-cli",
      "service.version": this.currentVersion,
      "agentcore-cli.installation_id": globalConfig.installationId,
      "agentcore-cli.session_id": this.sessionId,
      "os.type": os.type(),
      "os.version": os.release(),
      "host.arch": os.arch(),
      "node.version": process.version,
    });
  });
}

/** Returns true when AGENTCORE_TELEMETRY_DISABLED is set to "true" or "1". */
function telemetryDisabledByEnv(): boolean {
  const value = process.env.AGENTCORE_TELEMETRY_DISABLED?.toLowerCase().trim();
  return value === "true" || value === "1";
}

/** wraps an async function such that it only executes once **/
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let cachedPromise: Promise<T> | undefined;
  return () => (cachedPromise ??= fn());
}

type InMemoryMetricEventConfig<TMetricName extends MetricName> = {
  metricName: TMetricName;
  initialAttributes?: Partial<AttributesOf<TMetricName>>;
  logger: Logger;
  getSinks: () => Promise<MetricSink[]>;
};

/** An in-memory implementation of {@link MetricEvent} that accumulates attributes and emits on end() **/
class InMemoryMetricEvent<TMetricName extends MetricName> implements MetricEvent<TMetricName> {
  private data: Partial<AttributesOf<TMetricName>>;
  private readonly metricName: TMetricName;
  private readonly logger: Logger;
  private readonly getSinks: () => Promise<MetricSink[]>;

  constructor(config: InMemoryMetricEventConfig<TMetricName>) {
    this.metricName = config.metricName;
    this.data = config.initialAttributes ?? {};
    this.logger = config.logger;
    this.getSinks = config.getSinks;
  }

  setAttributes(newData: Partial<AttributesOf<TMetricName>>): void {
    this.data = {
      ...this.data,
      ...newData,
    };
  }

  async emit(value: ValueOf<TMetricName>): Promise<void> {
    const metricAttributes = METRICS[this.metricName]["attributeSchema"].parse(this.data);
    const validatedValue = METRICS[this.metricName]["valueSchema"].parse(value);

    const sinks = await this.getSinks();

    sinks.forEach((sink) => {
      try {
        sink.send(this.metricName, validatedValue, metricAttributes);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        this.logger
          .child({ errorName: error.name, errorMessage: error.message })
          .warn(`failed to record to sink '${sink.getName()}'`);
      }
    });
  }
}
