export { CloudWatchClient } from "./cloudWatchClient";
export { ObservabilityClient } from "./client";
export const DEFAULT_ENDPOINT_QUALIFIER = "DEFAULT";

export function runtimeLogGroup(runtimeId: string, endpoint: string): string {
  return `/aws/bedrock-agentcore/runtimes/${runtimeId}-${endpoint}`;
}
export {
  INSIGHTS_MAX_ROWS,
  runInsightsQuery,
  sanitizeQueryValue,
  type InsightsRowLimit,
} from "./insights";
export { TRACE_RECORD_LIMIT } from "./traces";
export type {
  CloudWatchLogEvent,
  CoreObservabilityClient,
  GetTraceQuery,
  InsightsQuery,
  InsightsQueryRow,
  ListTracesQuery,
  LogSearchQuery,
  LogSource,
  LogStreamQuery,
  LogStreamSource,
  LogTailQuery,
  TraceRecord,
  TraceSummary,
} from "./types";
