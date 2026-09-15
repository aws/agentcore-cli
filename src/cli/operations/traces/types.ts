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
  genAiOperation?: string;
  cloudResourceId?: string;
  endpointName?: string;
  agentId?: string;
  traceloopSpanKind?: string;
  openinferenceSpanKind?: string;
  requestModel?: string;
  responseModel?: string;
}

export interface QuerySpanRecordsOptions {
  region: string;
  logGroupName: string;
  traceId: string;
  startTime?: number;
  endTime?: number;
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

/** Aggregated latency/token metrics computed from one trace's spans. */
export interface TraceMetrics {
  traceId: string;
  spanCount: number;
  endToEndMs: number;
  /** 'invocation-span' when derived from the POST /invocations server span; 'span-envelope' is the labeled fallback. */
  timingSource: 'invocation-span' | 'span-envelope';
  /** LLM/tool/token fields are undefined (not zero) when application spans are unavailable for the trace. */
  llmMs?: number;
  llmCalls?: number;
  toolMs?: number;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Distinct LLM models observed in the trace (from gen_ai.response/request.model); undefined when none reported. */
  models?: string[];
}

export interface MetricDelta {
  baseline?: number;
  candidate?: number;
  delta?: number;
  /** Percentage change relative to baseline; null when the baseline is zero or absent. */
  deltaPercent?: number | null;
}

export type TraceComparisonMetricKey =
  | 'endToEndMs'
  | 'llmMs'
  | 'toolMs'
  | 'llmCalls'
  | 'toolCalls'
  | 'inputTokens'
  | 'outputTokens'
  | 'totalTokens';

export type TraceComparisonDeltas = Record<TraceComparisonMetricKey, MetricDelta>;

export interface CompareTracesOptions {
  region: string;
  runtimeId: string;
  baselineTraceId: string;
  candidateTraceId: string;
  startTime?: number;
  endTime?: number;
}

export type CompareTracesResult = Result<{
  baseline: TraceMetrics;
  candidate: TraceMetrics;
  deltas: TraceComparisonDeltas;
  warnings: string[];
}>;

export interface ListTracesOptions {
  region: string;
  runtimeId: string;
  agentName: string;
  limit?: number;
  startTime?: number;
  endTime?: number;
}

export type ListTracesResult = Result<{ traces: TraceEntry[] }>;
