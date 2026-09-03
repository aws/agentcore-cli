import type { CoreOptions } from "../types";
import { CloudWatchClient } from "./cloudWatchClient";
import type {
  CloudWatchLogEvent,
  GetTraceQuery,
  InsightsQuery,
  InsightsQueryRow,
  ListTracesQuery,
  LogSearchQuery,
  LogSource,
  LogTailQuery,
  TraceRecord,
  TraceSummary,
} from "./types";
import {
  getTraceInsightsQuery,
  listTracesInsightsQuery,
  normalizeTraceRecords,
  normalizeTraceSummaries,
} from "./traces";

/** Shared observability API over explicit CloudWatch log-group targets. */
export class ObservabilityClient {
  constructor(private readonly cloudWatch: CloudWatchClient) {}

  async *searchLogs(
    source: LogSource,
    query: LogSearchQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): AsyncGenerator<CloudWatchLogEvent, void> {
    yield* this.cloudWatch.searchLogs(source, query, options, signal);
  }

  async *tailLogs(
    source: LogSource,
    query: LogTailQuery,
    options: CoreOptions,
    signal: AbortSignal,
  ): AsyncGenerator<CloudWatchLogEvent, void> {
    yield* this.cloudWatch.tailLogs(source, query, options, signal);
  }

  queryLogs(
    source: LogSource,
    query: InsightsQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<InsightsQueryRow[]> {
    return this.cloudWatch.queryLogs(source, query, options, signal);
  }

  async listTraces(
    source: LogSource,
    query: ListTracesQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<TraceSummary[]> {
    const rows = await this.queryLogs(source, listTracesInsightsQuery(query), options, signal);
    return normalizeTraceSummaries(rows);
  }

  async getTrace(
    source: LogSource,
    query: GetTraceQuery,
    options: CoreOptions,
    signal?: AbortSignal,
  ): Promise<TraceRecord[]> {
    const rows = await this.queryLogs(source, getTraceInsightsQuery(query), options, signal);
    return normalizeTraceRecords(rows, query.traceId);
  }
}
