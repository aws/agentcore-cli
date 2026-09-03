import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import z from "zod";
import type {
  GetTraceQuery,
  ListTracesQuery,
  TraceRecord,
  TraceSummary,
} from "../../core/observability/index";
import { TRACE_RECORD_LIMIT } from "../../core/observability/index";
import { FileWriteError } from "../../errors";
import { atomicWrite, type AppIO } from "../../io";
import {
  argument,
  createHandler,
  flag,
  Router,
  type Context,
  type Flag,
  type Handler,
} from "../../router";
import { withUserCancellation } from "../../runnable";
import { JsonRendererKey } from "../../tui";
import { JsonKey } from "../keys";
import { resolveTimeWindow } from "./time";
import type { ResourceFlagValues } from "./types";

const DEFAULT_TRACES_WINDOW_MS = 12 * 3_600_000;
const TRACE_ID_WIDTH = 34;
const TIMESTAMP_WIDTH = 22;

const traceWindowFlags = [
  flag(
    "since",
    'window start: "5m", "1h", "2d", ISO 8601, epoch ms, or "now" (default 12h ago)',
    z.string().min(1).optional(),
  ),
  flag(
    "until",
    'window end: "5m", "1h", "2d", ISO 8601, epoch ms, or "now" (default now)',
    z.string().min(1).optional(),
  ),
] as const;

const outputSchema = z.string().min(1, "requires a nonempty path").optional();

const listTraceFlags = [
  flag("limit", "maximum number of traces to display", z.number().int().positive().default(20)),
  ...traceWindowFlags,
] as const;

const getTraceFlags = [
  flag("output", "the output file path", outputSchema),
  ...traceWindowFlags,
] as const;

type ListTraceFlagValues = ResourceFlagValues<typeof listTraceFlags>;
type GetTraceFlagValues = ResourceFlagValues<typeof getTraceFlags>;

export function formatTraceTimestamp(timestamp: string): string {
  const epochMs = Number(timestamp);
  if (isNaN(epochMs)) return timestamp;
  return new Date(epochMs)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z");
}

export function formatTraceTable(traces: TraceSummary[]): string {
  const lines = [
    `${"TRACE ID".padEnd(TRACE_ID_WIDTH)}${"TIMESTAMP".padEnd(TIMESTAMP_WIDTH)}SESSION ID`,
  ];
  for (const trace of traces) {
    lines.push(
      trace.traceId.padEnd(TRACE_ID_WIDTH) +
        formatTraceTimestamp(trace.timestamp).padEnd(TIMESTAMP_WIDTH) +
        (trace.sessionId ?? "-"),
    );
  }
  return lines.join("\n") + "\n";
}

export function createListTracesHandler<F extends readonly Flag<string, unknown>[]>(
  io: AppIO,
  config: {
    description: string;
    flags: F;
    read(
      ctx: Context,
      values: ResourceFlagValues<F> & ListTraceFlagValues,
      query: ListTracesQuery,
      signal: AbortSignal,
    ): Promise<TraceSummary[]>;
  },
): Handler {
  const listFlags = [...config.flags, ...listTraceFlags] as const;

  return createHandler({
    name: "list",
    description: config.description,
    flags: listFlags,
    handle: async (ctx, values) => {
      const parsed = values as unknown as ResourceFlagValues<F> & ListTraceFlagValues;
      const query: ListTracesQuery = {
        ...resolveTimeWindow({
          since: parsed.since,
          until: parsed.until,
          defaultWindowMs: DEFAULT_TRACES_WINDOW_MS,
        }),
        limit: parsed.limit,
      };
      const traces = await withUserCancellation((signal) =>
        config.read(ctx, parsed, query, signal),
      );

      if (ctx.require(JsonKey)) {
        ctx.require(JsonRendererKey).renderJson({ traces });
        return;
      }
      if (traces.length === 0) {
        io.stderr.write(
          "No traces found in the specified time range. Traces take 2-3 minutes " +
            "to appear after an invocation.\n",
        );
        return;
      }
      io.stdout.write(formatTraceTable(traces));
    },
  });
}

export function createGetTraceHandler<F extends readonly Flag<string, unknown>[]>(
  io: AppIO,
  config: {
    description: string;
    flags: F;
    read(
      ctx: Context,
      values: ResourceFlagValues<F> & GetTraceFlagValues,
      query: GetTraceQuery,
      signal: AbortSignal,
    ): Promise<TraceRecord[]>;
    resolveOutputPath(
      ctx: Context,
      values: ResourceFlagValues<F> & GetTraceFlagValues,
      request: { traceId: string; output?: string },
    ): string | Promise<string>;
  },
): Handler {
  const getFlags = [
    ...config.flags,
    flag(
      "output",
      "the output file path (default: <traceId>.json in the current directory)",
      outputSchema,
    ),
    ...traceWindowFlags,
  ] as const;

  return createHandler({
    name: "get",
    description: config.description,
    arguments: [argument("trace-id", "the trace ID to download", z.string().min(1))],
    flags: getFlags,
    handle: async (ctx, values, args) => {
      const parsed = values as unknown as ResourceFlagValues<F> & GetTraceFlagValues;
      const traceId = args["trace-id"];
      const query: GetTraceQuery = {
        ...resolveTimeWindow({
          since: parsed.since,
          until: parsed.until,
          defaultWindowMs: DEFAULT_TRACES_WINDOW_MS,
        }),
        traceId,
      };
      const records = await withUserCancellation((signal) =>
        config.read(ctx, parsed, query, signal),
      );
      const filePath = await config.resolveOutputPath(ctx, parsed, {
        traceId,
        output: parsed.output,
      });

      try {
        await mkdir(dirname(filePath), { recursive: true });
        await atomicWrite(filePath, JSON.stringify(records, null, 2));
      } catch (error) {
        throw new FileWriteError(
          `Could not write the trace file at ${filePath}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
          { cause: error, meta: { filePath } },
        );
      }

      if (records.length >= TRACE_RECORD_LIMIT) {
        io.stderr.write(
          `Warning: The trace query returned ${TRACE_RECORD_LIMIT.toLocaleString("en-US")} ` +
            "records, the maximum; the saved file may be incomplete. Narrow the time window " +
            "with --since and --until if needed.\n",
        );
      }

      if (ctx.require(JsonKey)) {
        ctx.require(JsonRendererKey).renderJson({ filePath, recordCount: records.length });
        return;
      }
      io.stderr.write(`Saved ${records.length} records for trace ${traceId}\n`);
      io.stdout.write(`${filePath}\n`);
    },
  });
}

export function createTracesHandler(config: {
  description: string;
  list: Handler;
  get: Handler;
}): Router {
  return new Router("traces", config.description).handler(config.list).handler(config.get);
}
