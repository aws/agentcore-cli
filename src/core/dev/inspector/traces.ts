import type { TraceStore } from "../otel/store";
import { buildTraceDetail, extractTraceMeta } from "./transforms";

const DEFAULT_LIST_WINDOW_MS = 12 * 60 * 60 * 1000;

export interface TraceSummary {
  traceId: string;
  timestamp: string;
  sessionId?: string;
  spanCount: string;
  resourceSpans?: unknown[];
  resourceLogs?: unknown[];
}

export interface TraceDetail {
  resourceSpans?: unknown[];
  resourceLogs?: unknown[];
}

export interface ListTracesOptions {
  serviceName?: string;
  startTime?: number;
  endTime?: number;
}

/**
 * Reads persisted traces and shapes them for the Inspector frontend. The list
 * includes full trace detail per entry — the SPA renders from the list response,
 * so this matches the wire contract of the original CLI.
 */
export class InspectorTraceSource {
  constructor(private readonly store: TraceStore) {}

  /** List traces newest-first, filtered by service name and time range (default: last 12 hours). */
  public async list(options: ListTracesOptions = {}): Promise<TraceSummary[]> {
    const now = Date.now();
    const start = options.startTime ?? now - DEFAULT_LIST_WINDOW_MS;
    const end = options.endTime ?? now;

    const summaries: TraceSummary[] = [];
    for (const trace of await this.store.readAll()) {
      const meta = extractTraceMeta(trace.resourceSpans, trace.resourceLogs);
      if (!meta.traceId) continue;
      if (meta.lastSeen < start || meta.firstSeen > end) continue;
      if (options.serviceName && meta.serviceName !== options.serviceName) continue;

      summaries.push({
        traceId: meta.traceId,
        timestamp: new Date(meta.lastSeen).toISOString(),
        sessionId: meta.sessionId,
        spanCount: String(meta.spanCount),
        ...buildTraceDetail(trace.resourceSpans, trace.resourceLogs),
      });
    }

    return summaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /** All spans and logs for one trace, or undefined when the trace is unknown. */
  public async get(traceId: string): Promise<TraceDetail | undefined> {
    const trace = await this.store.read(traceId);
    if (!trace) return undefined;
    return buildTraceDetail(trace.resourceSpans, trace.resourceLogs);
  }
}
