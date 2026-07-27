import type { MetricName, AttributesOf } from "./types";

/**
 * A strongly typed recorder for accumulating metric attributes, bound to a specific metric's schema.
 */
export class TelemetryAttributesRecorder<TMetricName extends MetricName> {
  private attributes: Partial<AttributesOf<TMetricName>>;

  constructor(
    _metricName: TMetricName,
    initialAttributes: Partial<AttributesOf<TMetricName>> = {},
  ) {
    this.attributes = initialAttributes;
  }

  getAttributes(): Partial<AttributesOf<TMetricName>> {
    return this.attributes;
  }

  record(data: Partial<AttributesOf<TMetricName>>): Partial<AttributesOf<TMetricName>> {
    this.attributes = {
      ...this.attributes,
      ...data,
    };
    return this.attributes;
  }
}
