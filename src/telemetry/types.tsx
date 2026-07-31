import z from "zod";
import { commandRunSchema } from "./shapes";

/**
 * The primary interface for telemetry that orchestrates the emitting of metrics
 */
export interface TelemetryClient {
  /**
   * Start a new metric event that accumulates attributes over its lifecycle.
   */
  startMetricEvent<TMetricName extends MetricName>(
    metricName: TMetricName,
    initialAttributes?: Partial<AttributesOf<TMetricName>>,
  ): MetricEvent<TMetricName>;

  shutdown(): Promise<void>;
}

/**
 * A single in-flight metric event. Accumulate attributes with record(), then
 * call end() to validate and emit. Throws if the metric is invalid.  
 */
export interface MetricEvent<TMetricName extends MetricName> {
  /** Accumulate attributes incrementally. Later calls overwrite earlier values for the same key. */
  setAttributes(data: Partial<AttributesOf<TMetricName>>): void;

  /** Validate attributes, emit value + attributes to all sinks. */
  end(value: ValueOf<TMetricName>): Promise<void>;
}

/**
 * A destination to send metric data.
 */
export interface MetricSink {
  /** Send data to the given metric sink **/
  send(
    metricName: string,
    value: number,
    attributes: Record<string, string | number | boolean>,
  ): void;
  /** Flush and close the given metric sink **/
  shutdown(): Promise<void>;
  getName(): string;
}

/**
 * Static definition of all metrics the CLI emits.
 */
export const METRICS = {
  "cli.command_run": {
    attributeSchema: commandRunSchema,
    // value describes duration (ms) of the command
    valueSchema: z.number().min(0),
  },
} satisfies Record<string, { attributeSchema: z.ZodType; valueSchema: z.ZodType }>;

export type MetricName = keyof typeof METRICS;

/**
 * Describes the value type for the given {@link Metric}
 */
export type ValueOf<TMetricName extends MetricName> = z.input<
  (typeof METRICS)[TMetricName]["valueSchema"]
>;

/**
 * Describes the attributes type for the given {@link Metric}
 */
export type AttributesOf<TMetricName extends MetricName> = z.input<
  (typeof METRICS)[TMetricName]["attributeSchema"]
>;
