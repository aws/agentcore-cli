import z from "zod";
import { parseTimeString } from "../../../../core/observability";
import type { AppIO } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import { JsonKey } from "../../../keys";
import type { Core } from "../../../types";
import { runtimeIdSchema } from "../../invoke/request";
import { resolveRuntimeTarget } from "../../resolveRuntimeTarget";
import type { TraceSummary } from "../../types";
import { DEFAULT_TRACES_WINDOW_MS } from "../index";

const TRACE_ID_WIDTH = 34;
const TIMESTAMP_WIDTH = 22;

/**
 * Renders a Logs Insights timestamp for the table. Aggregations return epoch
 * milliseconds as a string; anything non-numeric passes through untouched.
 */
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

export const createListRuntimeTracesHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "list",
    description: "list a Runtime's recent traces",
    flags: [
      flag(
        "id",
        "the ID of the Runtime (defaults to the project's deployed runtime)",
        runtimeIdSchema.optional(),
      ),
      flag("limit", "maximum number of traces to display", z.number().int().positive().default(20)),
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
    ],
    handle: async (ctx, flags) => {
      const startTimeMs =
        flags.since !== undefined
          ? parseTimeString(flags.since)
          : Date.now() - DEFAULT_TRACES_WINDOW_MS;
      const endTimeMs = flags.until !== undefined ? parseTimeString(flags.until) : Date.now();

      const target = await resolveRuntimeTarget(core, ctx, flags.id);
      const traces = await core.observability.listRuntimeTraces(
        { runtimeId: target.runtimeId, startTimeMs, endTimeMs, limit: flags.limit },
        target.options,
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
