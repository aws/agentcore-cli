import type { Logger } from "../logging";
import type { MetricSink } from "./types";

type LoggingSinkConfig = {
  logger: Logger;
};

/**
 * An implementation of {@link MetricSink} that logs metrics using the given logger
 */
export class LoggingSink implements MetricSink {
  private logger: Logger;

  constructor(config: LoggingSinkConfig) {
    this.logger = config.logger;
  }

  send(
    metricName: string,
    metricValue: number,
    metricAttributes: Record<string, string | number>,
  ): void {
    this.logger.child({ metricName, metricValue, metricAttributes }).info("recording telemetry");
  }

  async shutdown(): Promise<void> {}

  get name() {
    return "LoggingSink";
  }
}
