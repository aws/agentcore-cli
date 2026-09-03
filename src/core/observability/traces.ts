import { InputValidationError, ResourceNotFoundError } from "../../errors";
import { sanitizeQueryValue } from "./insights";
import type {
  GetTraceQuery,
  InsightsQuery,
  InsightsQueryRow,
  ListTracesQuery,
  TraceRecord,
  TraceSummary,
} from "./types";

export const TRACE_RECORD_LIMIT = 10_000;

// Trace ids are hex strings, optionally dash-separated (mirrors the old CLI).
const TRACE_ID_PATTERN = /^[a-fA-F0-9-]+$/;

export function listTracesInsightsQuery(query: ListTracesQuery): InsightsQuery {
  const limit = Math.floor(query.limit);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new InputValidationError("Trace limit must be a positive integer", {
      meta: { limit: query.limit },
    });
  }

  return {
    startTimeMs: query.startTimeMs,
    endTimeMs: query.endTimeMs,
    queryString:
      `filter ispresent(traceId) and traceId != ""\n` +
      `| stats earliest(@timestamp) as firstSeen, latest(@timestamp) as lastSeen, ` +
      `count(*) as spanCount, earliest(attributes.session.id) as sessionId by traceId\n` +
      `| sort lastSeen desc\n` +
      `| limit ${limit}`,
  };
}

export function normalizeTraceSummaries(rows: InsightsQueryRow[]): TraceSummary[] {
  const traces: TraceSummary[] = [];
  for (const row of rows) {
    if (!row.traceId) continue;
    traces.push({
      traceId: row.traceId,
      timestamp: row.lastSeen ?? row.firstSeen ?? "unknown",
      sessionId: row.sessionId,
      spanCount: row.spanCount,
    });
  }
  return traces;
}

export function getTraceInsightsQuery(query: GetTraceQuery): InsightsQuery {
  if (!TRACE_ID_PATTERN.test(query.traceId)) {
    throw new InputValidationError(
      "Invalid trace ID format. Expected a hex string (e.g., abc123def456).",
      { meta: { traceId: query.traceId } },
    );
  }

  return {
    startTimeMs: query.startTimeMs,
    endTimeMs: query.endTimeMs,
    queryString:
      `fields @timestamp, @message\n` +
      `| filter traceId = '${sanitizeQueryValue(query.traceId)}'\n` +
      `| sort @timestamp asc\n` +
      `| limit ${TRACE_RECORD_LIMIT}`,
  };
}

export function normalizeTraceRecords(rows: InsightsQueryRow[], traceId: string): TraceRecord[] {
  if (rows.length === 0) {
    throw new ResourceNotFoundError(`No trace data found for trace ID: ${traceId}`, {
      meta: { traceId },
    });
  }

  return rows.map((row) => {
    const record: TraceRecord = { ...row };
    const message = record["@message"];
    if (typeof message === "string") {
      try {
        record["@message"] = JSON.parse(message);
      } catch {
        // Keep the original string when the body is not valid JSON.
      }
    }
    return record;
  });
}
