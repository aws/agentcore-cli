export { buildTraceConsoleUrl } from './trace-url';
export { listTraces } from './list-traces';
export { fetchSpans, fetchTraceRecords, getTrace, querySpanRecords } from './get-trace';
export { aggregateSpans, buildTraceComparison, compareTraces } from './compare-traces';
export { runInsightsQuery, type InsightsQueryOptions, type InsightsQueryResult } from './insights-query';
export type {
  CloudWatchSpanRecord,
  CloudWatchTraceRecord,
  CompareTracesOptions,
  CompareTracesResult,
  FetchTraceRecordsOptions,
  FetchTraceRecordsResult,
  GetTraceOptions,
  GetTraceResult,
  ListTracesOptions,
  ListTracesResult,
  MetricDelta,
  TraceComparisonDeltas,
  TraceComparisonMetricKey,
  TraceEntry,
  TraceMetrics,
} from './types';
