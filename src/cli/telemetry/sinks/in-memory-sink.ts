import type { MetricSink } from './metric-sink.js';

export interface RecordedMetric {
  value: number;
  attrs: Record<string, string | number>;
}

export class InMemorySink implements MetricSink {
  readonly metrics: RecordedMetric[] = [];

  record(value: number, attrs: Record<string, string | number>): void {
    this.metrics.push({ value, attrs });
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async flush(): Promise<void> {}
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async shutdown(): Promise<void> {}
}
