import z from "zod";
import { commandRunSchema } from "./shapes";

/**
 * The primary interface for telemetry that orchestrates the emitting of metrics
 */
export interface TelemetryClient {
  /**
   * Get a recorder for accumulating attributes associated with a specific metric.  
   */
  getAttributesRecorder<TMetricName extends MetricName>(
    metricName: TMetricName,
    initialAttributes: Partial<AttributesOf<TMetricName>>,
  ): AttributesRecorder<AttributesOf<TMetricName>>;

  /**
   * Emits the given data, attaching the attributes stored in the given attribute recorder
   */
  emit<TMetricName extends MetricName>(
    metricName: TMetricName,
    metricValue: ValueOf<TMetricName>,
    attributesRecorder: AttributesRecorder<AttributesOf<TMetricName>>,
  ): Promise<void>;

  shutdown(): Promise<void>;
}

/**
 * A strongly typed recorder for accumulating metric attributes
 */
export interface AttributesRecorder<TAttributes extends Record<string, unknown>> {
  /**
   * Retrieves the underlying attributes
   */
  getAttributes(): Partial<TAttributes>;
  /**
   * Add attributes that overwrite existing values if already set.
   */
  record(data: Partial<TAttributes>): Partial<TAttributes>;
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
