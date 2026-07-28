import z from "zod";
import { commandRunSchema } from "./shapes";

/**
 * The primary interface for telemetry that orchestrates the emitting of metrics
 */
export interface TelemetryClient {
  emit<TMetricName extends MetricName>(
    metricName: TMetricName,
    metricValue: ValueOf<TMetricName>,
    attributes: AttributesOf<TMetricName>,
  ): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * A destination to send metric data.
 */
export interface MetricSink {
  /** Send data to the given metric sink **/
  send(metricName: string, value: number, attributes: Record<string, string | number>): void;
  /** Flush and close the given metric sink **/
  shutdown(): Promise<void>;
  name: string;
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
export type ValueOf<TMetricName extends MetricName> = z.infer<
  (typeof METRICS)[TMetricName]["valueSchema"]
>;

/**
 * Describes the attributes type for the given {@link Metric}
 */
export type AttributesOf<TMetricName extends MetricName> = z.infer<
  (typeof METRICS)[TMetricName]["attributeSchema"]
>;
