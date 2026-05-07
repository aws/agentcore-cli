export { buildTraceConsoleUrl } from './trace-url';
export { listTraces } from './list-traces';
export { fetchTraceRecords, getTrace } from './get-trace';
export { runInsightsQuery, type InsightsQueryOptions, type InsightsQueryResult } from './insights-query';
export type {
  CloudWatchSpanRecord,
  CloudWatchTraceRecord,
  FetchTraceRecordsOptions,
  FetchTraceRecordsResult,
  GetTraceOptions,
  GetTraceResult,
  ListTracesOptions,
  ListTracesResult,
  TraceEntry,
} from './types';
