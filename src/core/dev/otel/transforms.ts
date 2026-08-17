import type { OtlpPayload } from "./types";

/**
 * Split one OTLP export payload into per-trace payloads, keyed by hex trace id.
 * A single export batch routinely carries spans from several traces (SDKs batch
 * by time, not by trace), so persistence must not attribute a whole batch to
 * the first trace id it sees. Spans and log records without a trace id are dropped.
 * Resource and scope structure is preserved within each partition.
 */
export function partitionByTraceId(payload: OtlpPayload): Map<string, OtlpPayload> {
  const partitions = new Map<string, OtlpPayload>();
  const partition = (traceId: string): OtlpPayload => {
    let entry = partitions.get(traceId);
    if (!entry) {
      entry = {};
      partitions.set(traceId, entry);
    }
    return entry;
  };

  for (const resourceSpan of payload.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      const byTrace = groupBy(scopeSpan.spans ?? [], (span) => hexFromB64OrString(span.traceId));
      for (const [traceId, spans] of byTrace) {
        (partition(traceId).resourceSpans ??= []).push({
          resource: resourceSpan.resource,
          scopeSpans: [{ scope: scopeSpan.scope, spans }],
        });
      }
    }
  }

  for (const resourceLog of payload.resourceLogs ?? []) {
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      const byTrace = groupBy(scopeLog.logRecords ?? [], (record) =>
        hexFromB64OrString(record.traceId),
      );
      for (const [traceId, logRecords] of byTrace) {
        (partition(traceId).resourceLogs ??= []).push({
          resource: resourceLog.resource,
          scopeLogs: [{ scope: scopeLog.scope, logRecords }],
        });
      }
    }
  }

  return partitions;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    if (!groupKey) continue;
    const group = groups.get(groupKey);
    if (group) group.push(item);
    else groups.set(groupKey, [item]);
  }
  return groups;
}

/** Convert a nanosecond timestamp string to milliseconds (0 when absent). */
export function nanoToMs(nano: string | undefined): number {
  if (!nano) return 0;
  return Math.floor(Number(nano) / 1_000_000);
}

/**
 * Normalize a trace/span id that may be base64 (protobuf JSON conversion) or
 * already hex (JSON ingest) into lowercase hex.
 */
export function hexFromB64OrString(value: string | undefined): string {
  if (!value) return "";
  if (/^[0-9a-f]+$/i.test(value) && (value.length === 32 || value.length === 16))
    return value.toLowerCase();
  try {
    return Buffer.from(value, "base64").toString("hex");
  } catch {
    return value;
  }
}
