import type {
  OtlpAttributes,
  OtlpPayload,
  OtlpResource,
  OtlpResourceLog,
  OtlpResourceSpan,
} from "./types";

export interface TraceMeta {
  traceId?: string;
  firstSeen: number;
  lastSeen: number;
  sessionId?: string;
  /** Every service participating in the trace — a distributed trace spans several local agents. */
  serviceNames: string[];
}

/** Extract listing metadata (trace id, time bounds, session, service) from raw OTLP arrays. */
export function extractTraceMeta(
  resourceSpans: OtlpResourceSpan[],
  resourceLogs: OtlpResourceLog[],
): TraceMeta {
  const meta: TraceMeta = { firstSeen: Infinity, lastSeen: 0, serviceNames: [] };
  const services = new Set<string>();

  for (const resourceSpan of resourceSpans) {
    const service = getResourceAttribute(resourceSpan.resource, "service.name");
    if (service) services.add(service);
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        meta.traceId ??= hexFromB64OrString(span.traceId) || undefined;
        widenTimeBounds(meta, nanoToMs(span.startTimeUnixNano));
        widenTimeBounds(meta, nanoToMs(span.endTimeUnixNano));
        meta.sessionId ??=
          getAttributeValue(span.attributes, "session.id") ??
          getAttributeValue(span.attributes, "attributes.session.id");
      }
    }
  }

  for (const resourceLog of resourceLogs) {
    const service = getResourceAttribute(resourceLog.resource, "service.name");
    if (service) services.add(service);
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const record of scopeLog.logRecords ?? []) {
        meta.traceId ??= hexFromB64OrString(record.traceId) || undefined;
        widenTimeBounds(
          meta,
          nanoToMs(record.timeUnixNano) || nanoToMs(record.observedTimeUnixNano),
        );
      }
    }
  }

  const now = Date.now();
  if (meta.firstSeen === Infinity) meta.firstSeen = now;
  if (meta.lastSeen === 0) meta.lastSeen = now;
  meta.serviceNames = [...services];
  return meta;
}

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

/**
 * Build frontend-ready trace detail from raw OTLP arrays: ids to hex, attributes
 * flattened to plain records, transport-noise spans dropped, log bodies unwrapped.
 */
export function buildTraceDetail(
  resourceSpans: OtlpResourceSpan[],
  resourceLogs: OtlpResourceLog[],
): { resourceSpans?: unknown[]; resourceLogs?: unknown[] } {
  const spans = resourceSpans
    .map((resourceSpan) => ({
      resource: resourceSpan.resource
        ? { attributes: flattenAttributes(resourceSpan.resource.attributes) }
        : undefined,
      scopeSpans: resourceSpan.scopeSpans
        ?.map((scopeSpan) => ({
          scope: scopeSpan.scope,
          spans: scopeSpan.spans
            ?.map((span) => ({
              ...span,
              traceId: hexFromB64OrString(span.traceId),
              spanId: hexFromB64OrString(span.spanId),
              parentSpanId: hexFromB64OrString(span.parentSpanId),
              attributes: flattenAttributes(span.attributes),
            }))
            .filter((span) => isMeaningfulSpan(span)),
        }))
        .filter((scopeSpan) => scopeSpan.spans && scopeSpan.spans.length > 0),
    }))
    .filter((resourceSpan) => resourceSpan.scopeSpans && resourceSpan.scopeSpans.length > 0);

  const logs = resourceLogs
    .map((resourceLog) => ({
      resource: resourceLog.resource
        ? { attributes: flattenAttributes(resourceLog.resource.attributes) }
        : undefined,
      scopeLogs: resourceLog.scopeLogs?.map((scopeLog) => ({
        scope: scopeLog.scope,
        logRecords: scopeLog.logRecords?.map((record) => ({
          ...record,
          traceId: hexFromB64OrString(record.traceId),
          spanId: hexFromB64OrString(record.spanId),
          body: record.body === undefined ? undefined : extractAnyValue(record.body),
          attributes: flattenAttributes(record.attributes),
        })),
      })),
    }))
    .filter((resourceLog) => resourceLog.scopeLogs && resourceLog.scopeLogs.length > 0);

  return {
    resourceSpans: spans.length > 0 ? spans : undefined,
    resourceLogs: logs.length > 0 ? logs : undefined,
  };
}

/**
 * Whether a span carries application-level signal. Filters ASGI transport events,
 * bare HTTP client/server noise, and other framework spans that add nothing in the UI.
 */
function isMeaningfulSpan(span: {
  name?: string;
  kind?: number | string;
  attributes?: Record<string, unknown>;
}): boolean {
  const name = span.name ?? "";
  const attributes = span.attributes ?? {};
  const kind = normalizeSpanKind(span.kind);

  if (name.endsWith(" http send") || name.endsWith(" http receive")) return false;
  if (attributes["asgi.event.type"]) return false;
  if (Object.keys(attributes).some((key) => key.startsWith("gen_ai."))) return true;
  if (attributes["rpc.system"] || attributes["rpc.method"]) return true;

  const scopeHints = ["strands", "bedrock", "langchain", "crewai", "autogen", "google_adk"];
  if (scopeHints.some((hint) => name.toLowerCase().includes(hint))) return true;
  if (name === "tool_use" || name === "tool_call" || attributes["tool.name"]) return true;

  if (kind === SPAN_KIND.CLIENT && (name === "POST" || name === "GET" || name.startsWith("HTTP ")))
    return false;
  if (kind === SPAN_KIND.SERVER && name.startsWith("POST /") && attributes["http.method"])
    return false;

  return true;
}

const SPAN_KIND = { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 } as const;

/** Normalize a span kind from its protobuf enum name or number to the numeric value. */
function normalizeSpanKind(kind: number | string | undefined): number {
  if (typeof kind === "number") return kind;
  if (typeof kind === "string") {
    const name = kind.replace(/^SPAN_KIND_/, "") as keyof typeof SPAN_KIND;
    return SPAN_KIND[name] ?? 0;
  }
  return 0;
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

/** Flatten an OTLP key/value attribute array into a plain record. */
export function flattenAttributes(
  attributes: OtlpAttributes | undefined,
): Record<string, unknown> | undefined {
  if (!attributes || attributes.length === 0) return undefined;

  const flat: Record<string, unknown> = {};
  for (const attribute of attributes) {
    if (!attribute.value) continue;
    // One unwrap for every AnyValue variant — string/int/double/bool/array/kvlist —
    // so nested and kvlist-valued attributes flatten instead of silently dropping.
    flat[attribute.key] = extractAnyValue(attribute.value);
  }
  return flat;
}

/** Unwrap an OTLP AnyValue (string/int/double/bool/array/kvlist) into a plain value. */
export function extractAnyValue(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const anyValue = value as Record<string, unknown>;
  if (anyValue.stringValue !== undefined) return anyValue.stringValue;
  if (anyValue.intValue !== undefined) return Number(anyValue.intValue);
  if (anyValue.doubleValue !== undefined) return anyValue.doubleValue;
  if (anyValue.boolValue !== undefined) return anyValue.boolValue;
  if (anyValue.arrayValue && typeof anyValue.arrayValue === "object") {
    const { values } = anyValue.arrayValue as { values?: unknown[] };
    return (values ?? []).map(extractAnyValue);
  }
  if (anyValue.kvlistValue && typeof anyValue.kvlistValue === "object") {
    const { values } = anyValue.kvlistValue as { values?: { key: string; value?: unknown }[] };
    const record: Record<string, unknown> = {};
    for (const entry of values ?? []) {
      record[entry.key] = entry.value === undefined ? undefined : extractAnyValue(entry.value);
    }
    return record;
  }
  return value;
}

function getResourceAttribute(resource: OtlpResource | undefined, key: string): string | undefined {
  return getAttributeValue(resource?.attributes, key);
}

function getAttributeValue(
  attributes: OtlpAttributes | undefined,
  key: string,
): string | undefined {
  if (!attributes) return undefined;
  const attribute = attributes.find((entry) => entry.key === key);
  if (!attribute?.value) return undefined;
  return (
    attribute.value.stringValue ??
    (attribute.value.intValue != null ? String(attribute.value.intValue) : undefined)
  );
}

function widenTimeBounds(meta: TraceMeta, timeMs: number): void {
  if (!timeMs) return;
  if (timeMs < meta.firstSeen) meta.firstSeen = timeMs;
  if (timeMs > meta.lastSeen) meta.lastSeen = timeMs;
}
