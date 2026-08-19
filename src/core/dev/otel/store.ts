import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { buildTraceDetail, extractTraceMeta, partitionByTraceId } from "./transforms";
import type { OtlpPayload, OtlpResourceLog, OtlpResourceSpan } from "./types";

const OTLP_EXT = ".otlp.jsonl";
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
 * Append-only local trace storage: one JSON Lines file per trace (named by its
 * trace id), each line a per-trace slice of an OTLP export payload. No in-memory
 * state — reads go to disk on demand, which is fine because the inspector only
 * fetches traces on user actions. Malformed files and lines are skipped, never fatal.
 */
export class TraceStore {
  constructor(private readonly directory: string) {}

  /**
   * Persist one OTLP export payload, partitioned by trace id so a batch that
   * carries several traces lands in each trace's own file. Spans and log
   * records without a trace id are dropped.
   */
  public async append(payload: OtlpPayload): Promise<void> {
    const partitions = partitionByTraceId(payload);
    if (partitions.size === 0) return;

    await mkdir(this.directory, { recursive: true });
    await Promise.all(
      [...partitions].map(([traceId, partition]) =>
        appendFile(
          join(this.directory, `${sanitize(traceId)}${OTLP_EXT}`),
          JSON.stringify(partition) + "\n",
        ),
      ),
    );
  }

  /** List traces newest-first, filtered by service name and time range (default: last 12 hours). */
  public async list(options: ListTracesOptions = {}): Promise<TraceSummary[]> {
    const now = Date.now();
    const start = options.startTime ?? now - DEFAULT_LIST_WINDOW_MS;
    const end = options.endTime ?? now;

    const summaries: TraceSummary[] = [];
    for (const file of await this.traceFiles()) {
      const trace = await this.readTraceFile(file);
      if (!trace) continue;

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
    const trace = await this.readTraceFile(`${sanitize(traceId)}${OTLP_EXT}`);
    if (!trace) return undefined;
    return buildTraceDetail(trace.resourceSpans, trace.resourceLogs);
  }

  private async traceFiles(): Promise<string[]> {
    try {
      return (await readdir(this.directory)).filter((file) => file.endsWith(OTLP_EXT));
    } catch {
      return [];
    }
  }

  private async readTraceFile(
    fileName: string,
  ): Promise<{ resourceSpans: OtlpResourceSpan[]; resourceLogs: OtlpResourceLog[] } | undefined> {
    let content: string;
    try {
      content = await readFile(join(this.directory, fileName), "utf8");
    } catch {
      return undefined;
    }

    const resourceSpans: OtlpResourceSpan[] = [];
    const resourceLogs: OtlpResourceLog[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const payload = JSON.parse(line) as OtlpPayload;
        if (payload.resourceSpans) resourceSpans.push(...payload.resourceSpans);
        if (payload.resourceLogs) resourceLogs.push(...payload.resourceLogs);
      } catch {
        // Skip malformed lines — a partially written line must not break reads.
      }
    }
    return { resourceSpans, resourceLogs };
  }
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}
