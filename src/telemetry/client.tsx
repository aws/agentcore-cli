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
} from "./types";
import type { GlobalConfigAccessor } from "../globalConfig";
import { FileSystemSink } from "./fileSystemSink";
import path from "path";
import { PACKAGE_VERSION } from "../constants";

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

  async emit<TMetricName extends MetricName>(
    metricName: TMetricName,
    metricValue: ValueOf<TMetricName>,
    metricAttributes: AttributesOf<TMetricName>,
  ): Promise<void> {
    try {
      const metricSinks = await this.getMetricSinks();
      const resourceAttributes = await this.getResourceAttributes();
      // merge in resource attributes with metric attributes before sending to sink.
      const attributes = {
        ...resourceAttributes,
        ...metricAttributes,
      };

      const validatedMetricValue = METRICS[metricName]["valueSchema"].parse(metricValue);

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
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.logger
        .child({ errorName: error.name, errorMessage: error.message })
        .warn(`failed to emit telemetry`);
      // telemetry is best-effort, don't throw.
    }
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
      "service.version": PACKAGE_VERSION,
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
