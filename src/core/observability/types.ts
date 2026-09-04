import type { InsightsRowLimit } from "./insights";

/** Explicit CloudWatch Logs location selected by a primitive handler. */
export type LogSource = {
  logGroupName: string;
};

/** Exact CloudWatch log stream selected by a caller. */
export type LogStreamSource = LogSource & {
  logStreamName: string;
};

/** CloudWatch log event normalized at the AWS client boundary. */
export type CloudWatchLogEvent = {
  timestamp: Date;
  message: string;
  ingestionTime?: Date;
  logStreamName?: string;
};

export type LogStreamQuery = {
  /** Safety ceiling for callers that require a bounded stream read. */
  maxPages?: number;
};

export type LogSearchQuery = {
  startTimeMs: number;
  endTimeMs: number;
  filterPattern?: string;
  limit?: number;
};

export type LogTailQuery = {
  filterPattern?: string;
};

export type InsightsQuery = {
  queryString: string;
  startTimeMs: number;
  endTimeMs: number;
  rowLimit?: InsightsRowLimit;
};

export type InsightsQueryRow = Record<string, string>;

export type ListTracesQuery = {
  startTimeMs: number;
  endTimeMs: number;
  limit: number;
};

export type GetTraceQuery = {
  traceId: string;
  startTimeMs: number;
  endTimeMs: number;
};

/** One trace aggregated from telemetry records, newest first. */
export type TraceSummary = {
  traceId: string;
  timestamp: string;
  sessionId?: string;
  spanCount?: string;
};

/** One telemetry record belonging to a trace */
export type TraceRecord = Record<string, unknown>;
