import z from "zod";
import type { AppIO } from "../../../../io";
import { createHandler, flag } from "../../../../router";
import { JsonRendererKey } from "../../../../tui";
import { JsonKey } from "../../../keys";
import { resolveTimeWindow } from "../../../observability/time";
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
      flag("qualifier", "the Runtime endpoint qualifier", z.string().min(1).optional()),
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
      const { startTimeMs, endTimeMs } = resolveTimeWindow({
        since: flags.since,
        until: flags.until,
        defaultWindowMs: DEFAULT_TRACES_WINDOW_MS,
      });

      const target = await resolveRuntimeTarget(core, ctx, flags.id);
      const queryString =
        `filter ispresent(traceId) and traceId != ""\n` +
        `| stats earliest(@timestamp) as firstSeen, latest(@timestamp) as lastSeen, ` +
        `count(*) as spanCount, earliest(attributes.session.id) as sessionId by traceId\n` +
        `| sort lastSeen desc\n` +
        `| limit ${Math.floor(flags.limit)}`;
      const rows = await core.observability.queryLogs(
        {
          kind: "runtime",
          id: target.runtimeId,
          ...(flags.qualifier ? { qualifier: flags.qualifier } : {}),
        },
        { queryString, startTimeMs, endTimeMs },
        target.options,
      );
      const traces: TraceSummary[] = [];
      for (const fields of rows) {
        if (!fields.traceId) continue;
        traces.push({
          traceId: fields.traceId,
          timestamp: fields.lastSeen ?? fields.firstSeen ?? "unknown",
          sessionId: fields.sessionId,
          spanCount: fields.spanCount,
        });
      }

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
