/**
 * Wire shapes for OTLP/HTTP payloads after protobuf JSON conversion or JSON ingest.
 * Attributes always arrive as OTLP key/value arrays; we flatten them to plain
 * records only for display output, which is never read back through these types.
 */

export interface OtlpAttributeValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtlpAttributeValue[] };
  kvlistValue?: { values?: OtlpAttribute[] };
}

export interface OtlpAttribute {
  key: string;
  value?: OtlpAttributeValue;
}

export type OtlpAttributes = OtlpAttribute[];

export interface OtlpResource {
  attributes?: OtlpAttributes;
}

export interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number | string;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: OtlpAttributes;
  status?: { code?: number; message?: string };
  events?: unknown[];
}

export interface OtlpResourceSpan {
  resource?: OtlpResource;
  scopeSpans?: { scope?: { name?: string; version?: string }; spans?: OtlpSpan[] }[];
}

export interface OtlpLogRecord {
  timeUnixNano?: string;
  observedTimeUnixNano?: string;
  severityNumber?: number;
  severityText?: string;
  body?: unknown;
  attributes?: OtlpAttributes;
  traceId?: string;
  spanId?: string;
}

export interface OtlpResourceLog {
  resource?: OtlpResource;
  scopeLogs?: { scope?: { name?: string; version?: string }; logRecords?: OtlpLogRecord[] }[];
}

/** One OTLP export payload: what a single POST /v1/traces or /v1/logs carries. */
export interface OtlpPayload {
  resourceSpans?: OtlpResourceSpan[];
  resourceLogs?: OtlpResourceLog[];
}
