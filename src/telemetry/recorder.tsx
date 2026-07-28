import { type MetricName, type AttributesOf, METRICS } from "./types";

/**
 * A strongly typed recorder for accumulating metric attributes, bound to a specific metric's schema.
 */
export class TelemetryAttributesRecorder<TMetricName extends MetricName> {
  private attributes: Partial<AttributesOf<TMetricName>>;

  constructor(
    private readonly metricName: TMetricName,
    initialAttributes: Partial<AttributesOf<TMetricName>> = {},
  ) {
    this.attributes = initialAttributes;
  }

  /**
   * Retrieves the underlying attributes and validates them against the metric schema.
   * Throws if metric shape is invalid.
   */
  getAttributes(): AttributesOf<TMetricName> {
    const attributes = METRICS[this.metricName]["attributeSchema"].parse(this.attributes);
    return attributes as AttributesOf<TMetricName>;
  }

  /**
   * Add attributes that overwrite existing values if already set.
   */
  record(data: Partial<AttributesOf<TMetricName>>): Partial<AttributesOf<TMetricName>> {
    this.attributes = {
      ...this.attributes,
      ...data,
    };
    return this.attributes;
  }
}
