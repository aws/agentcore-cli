/** Protobuf decoder interface for OTLP messages. */
export interface ProtobufType {
  decode(data: Uint8Array): unknown;
}

export interface OtlpResource {
  attributes?: OtlpAttribute[] | Record<string, unknown>;
}

export interface OtlpAttribute {
  key: string;
  value?: OtlpAttributeValue;
}

export interface OtlpAttributeValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: OtlpAttributeValue[] };
  kvlistValue?: { values?: OtlpAttribute[] };
}

export interface OtlpResourceSpan {
  resource?: OtlpResource;
  scopeSpans?: { scope?: { name?: string; version?: string }; spans?: OtlpSpan[] }[];
}

export interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: OtlpAttribute[] | Record<string, unknown>;
  status?: { code?: number; message?: string };
  events?: unknown[];
}

export interface OtlpResourceLog {
  resource?: OtlpResource;
  scopeLogs?: { scope?: { name?: string; version?: string }; logRecords?: OtlpLogRecord[] }[];
}

export interface OtlpLogRecord {
  timeUnixNano?: string;
  observedTimeUnixNano?: string;
  severityNumber?: number;
  severityText?: string;
  body?: unknown;
  attributes?: OtlpAttribute[] | Record<string, unknown>;
  traceId?: string;
  spanId?: string;
}
