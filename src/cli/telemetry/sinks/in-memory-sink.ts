import type { MetricName } from '../schemas/registry.js';
import type { MetricSink } from './metric-sink.js';

export interface RecordedMetric {
  metric: MetricName;
  value: number;
  attrs: Record<string, string | number>;
}

export class InMemorySink implements MetricSink {
  readonly metrics: RecordedMetric[] = [];

  record(metricName: MetricName, value: number, attrs: Record<string, string | number>): void {
    this.metrics.push({ metric: metricName, value, attrs });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async flush(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async shutdown(): Promise<void> {}
}
