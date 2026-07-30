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
  type AttributesRecorder,
} from "./types";
import type { GlobalConfigAccessor } from "../globalConfig";
import { FileSystemSink } from "./fileSystemSink";
import path from "path";

export type DefaultTelemetryClientConfig = {
  logger: Logger;
  globalConfigAccessor: GlobalConfigAccessor;
  sessionId: string;
  metricSinks?: MetricSink[];
  auditFilePath?: string;
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
  constructor(config: DefaultTelemetryClientConfig) {
    this.logger = config.logger;
    this.sessionId = config.sessionId;
    this.globalConfigAccessor = config.globalConfigAccessor;
    this.metricSinksOverride = config.metricSinks;
    this.auditFilePath =
      config.auditFilePath ??
      path.join(os.homedir(), ".agentcore", "telemetry", `${this.sessionId}.jsonl`);
  }

  getAttributesRecorder<TMetricName extends MetricName>(
    _metricName: TMetricName,
    initialAttributes: Partial<AttributesOf<TMetricName>> = {},
  ): AttributesRecorder<AttributesOf<TMetricName>> {
    return new InMemoryAttributesRecorder(initialAttributes);
  }

  async emit<TMetricName extends MetricName>(
    metricName: TMetricName,
    metricValue: ValueOf<TMetricName>,
    attributesRecorder: AttributesRecorder<AttributesOf<TMetricName>>,
  ): Promise<void> {
    const metricSinks = await this.getMetricSinks();
    const resourceAttributes = await this.getResourceAttributes();

    const metricAttributes = METRICS[metricName]["attributeSchema"].parse(
      attributesRecorder.getAttributes(),
    );
    const validatedMetricValue = METRICS[metricName]["valueSchema"].parse(metricValue);

    // merge in resource attributes with metric attributes before sending to sink.
    const attributes = {
      ...resourceAttributes,
      ...metricAttributes,
    };

    metricSinks.forEach((sink) => {
      try {
        sink.send(metricName, validatedMetricValue, attributes);
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        this.logger
          .child({ errorName: error.name, errorMessage: error.message })
          .warn(`failed to record to sink '${sink.getName()}'`);
        // do not allow a single sink failure to fail other sinks.
      }
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

    const metricSinks = [];

    const globalConfig = await this.globalConfigAccessor.get();

    if (globalConfig.telemetry.audit)
      metricSinks.push(
        new FileSystemSink({
          logger: this.logger.child({ module: "fileSystemSink" }),
          filePath: this.auditFilePath,
        }),
      );

    return metricSinks;
  });

  private getResourceAttributes: () => Promise<ResourceAttributes> = once(async () => {
    const globalConfig = await this.globalConfigAccessor.get();
    return resourceAttributesSchema.parse({
      "service.name": "agentcore-cli",
      // TODO: wire up real package version.
      "service.version": "0.0.0",
      "agentcore-cli.installation_id": globalConfig.installationId,
      "agentcore-cli.session_id": this.sessionId,
      "os.type": os.type(),
      "os.version": os.release(),
      "host.arch": os.arch(),
      "node.version": process.version,
    });
  });
}

/** wraps an async function such that it only executes once **/
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let cachedPromise: Promise<T> | undefined;
  return () => (cachedPromise ??= fn());
}

/** An in-memory implementation of {@link AttributesRecorder} that stores the data in memory **/
class InMemoryAttributesRecorder<
  TAttributes extends Record<string, unknown>,
> implements AttributesRecorder<TAttributes> {
  private data: Partial<TAttributes>;

  constructor(initialAttributes?: Partial<TAttributes>) {
    this.data = initialAttributes ?? {};
  }

  record(newData: Partial<TAttributes>): Partial<TAttributes> {
    this.data = {
      ...this.data,
      ...newData,
    };
    return this.data;
  }

  getAttributes(): Partial<TAttributes> {
    return this.data;
  }
}
