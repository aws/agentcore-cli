import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { partitionByTraceId } from "./transforms";
import type { OtlpPayload, OtlpResourceLog, OtlpResourceSpan } from "./types";

const OTLP_EXT = ".otlp.jsonl";

/** All raw OTLP data persisted for one trace. */
export interface RawTrace {
  resourceSpans: OtlpResourceSpan[];
  resourceLogs: OtlpResourceLog[];
}

/**
 * Append-only local trace storage: one JSON Lines file per trace (named by its
 * trace id), each line a per-trace slice of an OTLP export payload. Raw storage
 * only — presentation shaping lives in core/dev/inspector. No in-memory state;
 * reads go to disk on demand. Malformed files and lines are skipped, never fatal.
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

  /** The raw persisted data for one trace, or undefined when the trace is unknown. */
  public async read(traceId: string): Promise<RawTrace | undefined> {
    return this.readTraceFile(`${sanitize(traceId)}${OTLP_EXT}`);
  }

  /** The raw persisted data of every stored trace. */
  public async readAll(): Promise<RawTrace[]> {
    const traces: RawTrace[] = [];
    for (const file of await this.traceFiles()) {
      const trace = await this.readTraceFile(file);
      if (trace) traces.push(trace);
    }
    return traces;
  }

  private async traceFiles(): Promise<string[]> {
    try {
      return (await readdir(this.directory)).filter((file) => file.endsWith(OTLP_EXT));
    } catch {
      return [];
    }
  }

  private async readTraceFile(fileName: string): Promise<RawTrace | undefined> {
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
