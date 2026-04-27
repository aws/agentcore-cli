/**
 * A destination for metric data. Implementations handle transport (OTel, file, etc.).
 */
export interface MetricSink {
  record(value: number, attrs: Record<string, string | number>): void;
  flush(timeoutMs?: number): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * Fans out to multiple sinks. All sinks receive every record.
 * Errors in one sink don't affect others.
 */
export class CompositeSink implements MetricSink {
  constructor(private readonly sinks: MetricSink[]) {}

  record(value: number, attrs: Record<string, string | number>): void {
    for (const sink of this.sinks) {
      try {
        sink.record(value, attrs);
      } catch {
        // Individual sink failure must not affect others
      }
    }
  }

  async flush(timeoutMs?: number): Promise<void> {
    await Promise.allSettled(this.sinks.map(s => s.flush(timeoutMs)));
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.sinks.map(s => s.shutdown()));
  }
}
