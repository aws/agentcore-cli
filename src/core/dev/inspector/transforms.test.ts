import { describe, expect, test } from "bun:test";
import type { OtlpResourceLog, OtlpResourceSpan } from "../otel/types";
import {
  buildTraceDetail,
  extractAnyValue,
  extractTraceMeta,
  flattenAttributes,
} from "./transforms";

const TRACE_ID_HEX = "0123456789abcdef0123456789abcdef";
const TRACE_ID_B64 = Buffer.from(TRACE_ID_HEX, "hex").toString("base64");
const SPAN_ID_HEX = "0123456789abcdef";

function resourceSpan(overrides: { serviceName?: string; spans: object[] }): OtlpResourceSpan {
  return {
    resource: overrides.serviceName
      ? { attributes: [{ key: "service.name", value: { stringValue: overrides.serviceName } }] }
      : undefined,
    scopeSpans: [{ scope: { name: "test-scope" }, spans: overrides.spans }],
  };
}

const agentSpan = {
  traceId: TRACE_ID_B64,
  spanId: SPAN_ID_HEX,
  name: "invoke_agent strands",
  kind: 1,
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000001500000000",
  attributes: [
    { key: "gen_ai.prompt", value: { stringValue: "hello" } },
    { key: "session.id", value: { stringValue: "session-1" } },
  ],
};

describe("extractTraceMeta", () => {
  test("collects trace id, time bounds, session, service, and span count", () => {
    const meta = extractTraceMeta(
      [resourceSpan({ serviceName: "my-agent", spans: [agentSpan] })],
      [],
    );
    expect(meta).toEqual({
      traceId: TRACE_ID_HEX,
      firstSeen: 1700000000000,
      lastSeen: 1700000001500,
      sessionId: "session-1",
      serviceName: "my-agent",
      spanCount: 1,
    });
  });

  test("counts log records and falls back to observed time", () => {
    const logs: OtlpResourceLog[] = [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "log-agent" } }] },
        scopeLogs: [
          {
            scope: {},
            logRecords: [{ traceId: TRACE_ID_HEX, observedTimeUnixNano: "1700000002000000000" }],
          },
        ],
      },
    ];
    const meta = extractTraceMeta([], logs);
    expect(meta.traceId).toBe(TRACE_ID_HEX);
    expect(meta.serviceName).toBe("log-agent");
    expect(meta.spanCount).toBe(1);
    expect(meta.firstSeen).toBe(1700000002000);
    expect(meta.lastSeen).toBe(1700000002000);
  });

  test("defaults time bounds to now when no timestamps exist", () => {
    const before = Date.now();
    const meta = extractTraceMeta([], []);
    expect(meta.firstSeen).toBeGreaterThanOrEqual(before);
    expect(meta.lastSeen).toBeGreaterThanOrEqual(before);
    expect(meta.traceId).toBeUndefined();
  });
});

describe("buildTraceDetail", () => {
  test("hexes ids, flattens attributes, and unwraps log bodies", () => {
    const detail = buildTraceDetail(
      [resourceSpan({ serviceName: "svc", spans: [agentSpan] })],
      [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
          scopeLogs: [
            {
              scope: {},
              logRecords: [
                { traceId: TRACE_ID_B64, spanId: SPAN_ID_HEX, body: { stringValue: "log line" } },
              ],
            },
          ],
        },
      ],
    );

    const spans = detail.resourceSpans as {
      resource: { attributes: Record<string, unknown> };
      scopeSpans: { spans: { traceId: string; attributes: Record<string, unknown> }[] }[];
    }[];
    expect(spans[0]!.resource.attributes).toEqual({ "service.name": "svc" });
    expect(spans[0]!.scopeSpans[0]!.spans[0]!.traceId).toBe(TRACE_ID_HEX);
    expect(spans[0]!.scopeSpans[0]!.spans[0]!.attributes).toEqual({
      "gen_ai.prompt": "hello",
      "session.id": "session-1",
    });

    const logs = detail.resourceLogs as {
      scopeLogs: { logRecords: { traceId: string; body: unknown }[] }[];
    }[];
    expect(logs[0]!.scopeLogs[0]!.logRecords[0]!.traceId).toBe(TRACE_ID_HEX);
    expect(logs[0]!.scopeLogs[0]!.logRecords[0]!.body).toBe("log line");
  });

  test("filters transport noise but keeps meaningful spans", () => {
    const noiseSpans = [
      { name: "GET / http send", attributes: [] },
      {
        name: "http.request",
        attributes: [{ key: "asgi.event.type", value: { stringValue: "http.request" } }],
      },
      { name: "POST", kind: 3, attributes: [] },
      {
        name: "POST /invocations",
        kind: 2,
        attributes: [{ key: "http.method", value: { stringValue: "POST" } }],
      },
    ];
    const detail = buildTraceDetail([resourceSpan({ spans: [...noiseSpans, agentSpan] })], []);
    const spans = detail.resourceSpans as { scopeSpans: { spans: { name: string }[] }[] }[];
    expect(spans[0]!.scopeSpans[0]!.spans.map((span) => span.name)).toEqual([
      "invoke_agent strands",
    ]);
  });

  test("string span kinds from JSON ingest are normalized before filtering", () => {
    const detail = buildTraceDetail(
      [resourceSpan({ spans: [{ name: "POST", kind: "SPAN_KIND_CLIENT", attributes: [] }] })],
      [],
    );
    expect(detail.resourceSpans).toBeUndefined();
  });

  test("returns undefined sections when everything is filtered or empty", () => {
    expect(buildTraceDetail([], [])).toEqual({ resourceSpans: undefined, resourceLogs: undefined });
  });
});

describe("value helpers", () => {
  test("flattenAttributes handles typed values, arrays, and flat passthrough", () => {
    expect(
      flattenAttributes([
        { key: "s", value: { stringValue: "x" } },
        { key: "i", value: { intValue: "42" } },
        { key: "d", value: { doubleValue: 1.5 } },
        { key: "b", value: { boolValue: true } },
        { key: "a", value: { arrayValue: { values: [{ stringValue: "y" }, { intValue: "7" }] } } },
        { key: "skipped" },
      ]),
    ).toEqual({ s: "x", i: 42, d: 1.5, b: true, a: ["y", "7"] });
    expect(flattenAttributes({ already: "flat" })).toEqual({ already: "flat" });
    expect(flattenAttributes([])).toBeUndefined();
    expect(flattenAttributes(undefined)).toBeUndefined();
  });

  test("extractAnyValue unwraps nested kvlist and array values", () => {
    expect(
      extractAnyValue({
        kvlistValue: {
          values: [
            {
              key: "nested",
              value: { arrayValue: { values: [{ intValue: "1" }, { boolValue: false }] } },
            },
            { key: "plain", value: { stringValue: "v" } },
          ],
        },
      }),
    ).toEqual({ nested: [1, false], plain: "v" });
    expect(extractAnyValue("passthrough")).toBe("passthrough");
    expect(extractAnyValue(null)).toBeNull();
  });
});
