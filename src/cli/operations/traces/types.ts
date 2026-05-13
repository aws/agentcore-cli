import type { Result } from '../../../lib/result';

export interface CloudWatchTraceRecord {
  '@timestamp': string;
  '@message': unknown;
  '@ptr'?: string;
}

export interface CloudWatchSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  kind?: string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  durationNano?: string;
  statusCode?: string;
  serviceName?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  httpStatusCode?: number;
  sessionId?: string;
}

export interface FetchTraceRecordsOptions {
  region: string;
  runtimeId: string;
  traceId: string;
  startTime?: number;
  endTime?: number;
  includeSpans?: boolean;
}

export type FetchTraceRecordsResult = Result<{
  records: CloudWatchTraceRecord[];
  spans?: CloudWatchSpanRecord[];
}>;

export interface GetTraceOptions {
  region: string;
  runtimeId: string;
  agentName: string;
  traceId: string;
  outputPath?: string;
  startTime?: number;
  endTime?: number;
}

export type GetTraceResult = Result<{ filePath: string }>;

export interface TraceEntry {
  traceId: string;
  timestamp: string;
  sessionId?: string;
  spanCount?: string;
}

export interface ListTracesOptions {
  region: string;
  runtimeId: string;
  agentName: string;
  limit?: number;
  startTime?: number;
  endTime?: number;
}

export type ListTracesResult = Result<{ traces: TraceEntry[] }>;
