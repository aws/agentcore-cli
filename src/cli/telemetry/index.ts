export { resolveTelemetryPreference, resolveResourceAttributes, resolveAuditFilePath } from './config.js';
export type { TelemetryPreference } from './config.js';
export { TelemetryClientAccessor } from './client-accessor.js';
export { TelemetryClient } from './client.js';
export { type MetricSink } from './sinks/metric-sink.js';
export { OtelMetricSink, type OtelMetricSinkConfig } from './sinks/otel-metric-sink.js';
export { FileSystemSink, type FileSystemSinkConfig } from './sinks/filesystem-sink.js';
