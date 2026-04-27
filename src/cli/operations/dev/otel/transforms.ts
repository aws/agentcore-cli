import type { OtlpAttribute, OtlpAttributeValue, OtlpResource, OtlpResourceLog, OtlpResourceSpan } from './types';

// ---------------------------------------------------------------------------
// Trace metadata extraction (from raw OTLP data)
// ---------------------------------------------------------------------------

export interface TraceMeta {
  traceId?: string;
  firstSeen: number;
  lastSeen: number;
  sessionId?: string;
  serviceName?: string;
  spanCount: number;
}

/** Extract metadata from raw OTLP resource arrays. */
export function extractTraceMeta(resourceSpans: OtlpResourceSpan[], resourceLogs: OtlpResourceLog[]): TraceMeta {
  let traceId: string | undefined;
  let firstSeen = Infinity;
  let lastSeen = 0;
  let sessionId: string | undefined;
  let serviceName: string | undefined;
  let spanCount = 0;

  for (const rs of resourceSpans) {
    serviceName ??= getResourceAttribute(rs.resource, 'service.name');
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        spanCount++;
        traceId ??= hexFromB64OrString(span.traceId) || undefined;
        const startMs = nanoToMs(span.startTimeUnixNano);
        const endMs = nanoToMs(span.endTimeUnixNano);
        if (startMs && startMs < firstSeen) firstSeen = startMs;
        if (endMs && endMs > lastSeen) lastSeen = endMs;
        if (!sessionId) {
          const attrs = span.attributes;
          sessionId = getAttrValue(attrs, 'session.id') ?? getAttrValue(attrs, 'attributes.session.id');
        }
      }
    }
  }

  for (const rl of resourceLogs) {
    serviceName ??= getResourceAttribute(rl.resource, 'service.name');
    for (const sl of rl.scopeLogs ?? []) {
      for (const lr of sl.logRecords ?? []) {
        spanCount++;
        traceId ??= hexFromB64OrString(lr.traceId) || undefined;
        const timeMs = nanoToMs(lr.timeUnixNano) || nanoToMs(lr.observedTimeUnixNano);
        if (timeMs && timeMs < firstSeen) firstSeen = timeMs;
        if (timeMs && timeMs > lastSeen) lastSeen = timeMs;
      }
    }
  }

  const now = Date.now();
  if (firstSeen === Infinity) firstSeen = now;
  if (lastSeen === 0) lastSeen = now;

  return { traceId, firstSeen, lastSeen, sessionId, serviceName, spanCount };
}

/** Extract traceId and serviceName from the first span/log in a payload. */
export function extractFirstTraceInfo(data: { resourceSpans?: OtlpResourceSpan[]; resourceLogs?: OtlpResourceLog[] }): {
  traceId?: string;
  serviceName?: string;
} {
  if (data.resourceSpans) {
    for (const rs of data.resourceSpans) {
      const svc = getResourceAttribute(rs.resource, 'service.name');
      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) {
          if (span.traceId) return { traceId: hexFromB64OrString(span.traceId), serviceName: svc };
        }
      }
    }
  }
  if (data.resourceLogs) {
    for (const rl of data.resourceLogs) {
      const svc = getResourceAttribute(rl.resource, 'service.name');
      for (const sl of rl.scopeLogs ?? []) {
        for (const lr of sl.logRecords ?? []) {
          if (lr.traceId) return { traceId: hexFromB64OrString(lr.traceId), serviceName: svc };
        }
      }
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Trace detail: flatten attributes, filter noise, extract log bodies
// ---------------------------------------------------------------------------

/**
 * Build frontend-ready trace detail from raw OTLP resource arrays.
 * Flattens attributes to Record<string, unknown>, filters noise spans,
 * and extracts log body values.
 */
export function buildTraceDetail(
  resourceSpans: OtlpResourceSpan[],
  resourceLogs: OtlpResourceLog[]
): { resourceSpans?: unknown[]; resourceLogs?: unknown[] } {
  const filteredSpans = resourceSpans
    .map(rs => ({
      resource: rs.resource ? { attributes: flattenAttributes(rs.resource.attributes) } : undefined,
      scopeSpans: rs.scopeSpans
        ?.map(ss => ({
          scope: ss.scope,
          spans: ss.spans
            ?.map(span => ({
              ...span,
              traceId: hexFromB64OrString(span.traceId),
              spanId: hexFromB64OrString(span.spanId),
              parentSpanId: hexFromB64OrString(span.parentSpanId),
              attributes: flattenAttributes(span.attributes),
            }))
            .filter(span => isMeaningfulSpan(span)),
        }))
        .filter(ss => ss.spans && ss.spans.length > 0),
    }))
    .filter(rs => rs.scopeSpans && rs.scopeSpans.length > 0);

  const flattenedLogs = resourceLogs
    .map(rl => ({
      resource: rl.resource ? { attributes: flattenAttributes(rl.resource.attributes) } : undefined,
      scopeLogs: rl.scopeLogs?.map(sl => ({
        scope: sl.scope,
        logRecords: sl.logRecords?.map(lr => ({
          ...lr,
          traceId: hexFromB64OrString(lr.traceId),
          spanId: hexFromB64OrString(lr.spanId),
          body: lr.body ? extractAnyValue(lr.body) : undefined,
          attributes: flattenAttributes(lr.attributes),
        })),
      })),
    }))
    .filter(rl => rl.scopeLogs && rl.scopeLogs.length > 0);

  return {
    resourceSpans: filteredSpans.length > 0 ? filteredSpans : undefined,
    resourceLogs: flattenedLogs.length > 0 ? flattenedLogs : undefined,
  };
}

// ---------------------------------------------------------------------------
// Span filtering
// ---------------------------------------------------------------------------

/**
 * Determine if a trace span contains meaningful application data.
 * Filters out ASGI transport noise, HTTP client noise, and other
 * low-level framework spans that add no value in the trace UI.
 */
function isMeaningfulSpan(span: {
  name?: string;
  kind?: number | string;
  attributes?: Record<string, unknown>;
}): boolean {
  const name = span.name ?? '';
  const attrs = span.attributes ?? {};
  const kind = normalizeSpanKind(span.kind);

  if (name.endsWith(' http send') || name.endsWith(' http receive')) return false;
  if (attrs['asgi.event.type']) return false;
  if (Object.keys(attrs).some(k => k.startsWith('gen_ai.'))) return true;
  if (attrs['rpc.system'] || attrs['rpc.method']) return true;

  const scopeHints = ['strands', 'bedrock', 'langchain', 'crewai', 'autogen', 'google_adk'];
  if (scopeHints.some(h => name.toLowerCase().includes(h))) return true;
  if (name === 'tool_use' || name === 'tool_call' || attrs['tool.name']) return true;

  if (kind === 3 && (name === 'POST' || name === 'GET' || name.startsWith('HTTP '))) return false;
  if (kind === 2 && name.startsWith('POST /') && attrs['http.method']) return false;

  return true;
}

/** Normalize span kind from string enum name or number to a numeric value. */
function normalizeSpanKind(kind: number | string | undefined): number {
  if (typeof kind === 'number') return kind;
  if (typeof kind === 'string') {
    const map: Record<string, number> = {
      SPAN_KIND_INTERNAL: 1,
      SPAN_KIND_SERVER: 2,
      SPAN_KIND_CLIENT: 3,
      SPAN_KIND_PRODUCER: 4,
      SPAN_KIND_CONSUMER: 5,
    };
    return map[kind] ?? 0;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert nanosecond timestamp (string) to milliseconds. */
export function nanoToMs(nano: string | undefined): number {
  if (!nano) return 0;
  return Math.floor(Number(nano) / 1_000_000);
}

/**
 * Convert a value that may be base64 (from protobuf JSON roundtrip) or
 * already a hex string into a hex string.
 */
export function hexFromB64OrString(val: string | undefined): string {
  if (!val) return '';
  // Already hex (32 chars for traceId, 16 for spanId)
  if (/^[0-9a-f]+$/i.test(val) && (val.length === 32 || val.length === 16)) return val.toLowerCase();
  // Base64 from protobuf JSON.stringify roundtrip
  try {
    return Buffer.from(val, 'base64').toString('hex');
  } catch {
    return val;
  }
}

/** Get a string attribute from an OTLP resource. */
function getResourceAttribute(resource: OtlpResource | undefined, key: string): string | undefined {
  return getAttrValue(resource?.attributes, key);
}

/** Get a string value from attributes (handles both array and flat record formats). */
function getAttrValue(attrs: OtlpAttribute[] | Record<string, unknown> | undefined, key: string): string | undefined {
  if (!attrs) return undefined;
  if (Array.isArray(attrs)) {
    const attr = attrs.find(a => a.key === key);
    if (!attr?.value) return undefined;
    return attr.value.stringValue ?? (attr.value.intValue != null ? String(attr.value.intValue) : undefined);
  }
  const val = attrs[key];
  return typeof val === 'string' ? val : undefined;
}

/**
 * Flatten OTLP attributes to a plain Record<string, unknown>.
 * Handles both OTLP key/value array format and already-flat records.
 */
export function flattenAttributes(
  attrs: OtlpAttribute[] | Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!attrs) return undefined;
  if (!Array.isArray(attrs)) return attrs;
  if (attrs.length === 0) return undefined;

  const result: Record<string, unknown> = {};
  for (const attr of attrs) {
    if (!attr.value) continue;
    if (attr.value.stringValue !== undefined) result[attr.key] = attr.value.stringValue;
    else if (attr.value.intValue !== undefined) result[attr.key] = Number(attr.value.intValue);
    else if (attr.value.doubleValue !== undefined) result[attr.key] = attr.value.doubleValue;
    else if (attr.value.boolValue !== undefined) result[attr.key] = attr.value.boolValue;
    else if (attr.value.arrayValue?.values) {
      result[attr.key] = attr.value.arrayValue.values.map(
        (v: OtlpAttributeValue) => v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? null
      );
    }
  }
  return result;
}

/** Extract a usable value from an OTLP AnyValue. */
export function extractAnyValue(val: unknown): unknown {
  if (!val || typeof val !== 'object') return val;
  const v = val as Record<string, unknown>;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue && typeof v.arrayValue === 'object') {
    const arr = v.arrayValue as { values?: unknown[] };
    return (arr.values ?? []).map(extractAnyValue);
  }
  if (v.kvlistValue && typeof v.kvlistValue === 'object') {
    const kvlist = v.kvlistValue as { values?: { key: string; value?: unknown }[] };
    const obj: Record<string, unknown> = {};
    for (const kv of kvlist.values ?? []) {
      obj[kv.key] = kv.value ? extractAnyValue(kv.value) : undefined;
    }
    return obj;
  }
  return val;
}
