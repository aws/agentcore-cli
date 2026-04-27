export { resolveTelemetryPreference, resolveResourceAttributes } from './config.js';
export type { TelemetryPreference } from './config.js';
export { TelemetryClient, CANCELLED } from './client.js';
export { type MetricSink, CompositeSink } from './sinks/metric-sink.js';
export { OtelMetricSink, type OtelMetricSinkConfig } from './sinks/otel-metric-sink.js';
export { classifyError, isUserError } from './error-classification.js';
