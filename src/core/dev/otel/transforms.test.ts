import { describe, expect, test } from "bun:test";
import {
  buildTraceDetail,
  extractAnyValue,
  extractTraceMeta,
  flattenAttributes,
  hexFromB64OrString,
  nanoToMs,
  partitionByTraceId,
} from "./transforms";
import type { OtlpResourceLog, OtlpResourceSpan } from "./types";

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
  test("collects trace id, time bounds, session, and service", () => {
    const meta = extractTraceMeta(
      [resourceSpan({ serviceName: "my-agent", spans: [agentSpan] })],
      [],
    );
    expect(meta).toEqual({
      traceId: TRACE_ID_HEX,
      firstSeen: 1700000000000,
      lastSeen: 1700000001500,
      sessionId: "session-1",
      serviceNames: ["my-agent"],
    });
  });

  test("reads trace id, service, and observed time from logs alone", () => {
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
    expect(meta.serviceNames).toEqual(["log-agent"]);
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

describe("partitionByTraceId", () => {
  const OTHER_TRACE_HEX = "ffffffffffffffffffffffffffffffff";

  test("splits a batch carrying several traces into per-trace payloads", () => {
    const otherSpan = { ...agentSpan, traceId: OTHER_TRACE_HEX, name: "tool_use" };
    const partitions = partitionByTraceId({
      resourceSpans: [resourceSpan({ serviceName: "svc", spans: [agentSpan, otherSpan] })],
    });

    expect([...partitions.keys()].sort()).toEqual([TRACE_ID_HEX, OTHER_TRACE_HEX]);
    const first = partitions.get(TRACE_ID_HEX)!.resourceSpans![0] as OtlpResourceSpan;
    expect(first.scopeSpans![0]!.spans).toEqual([agentSpan]);
    expect(first.resource).toBeDefined();
    const second = partitions.get(OTHER_TRACE_HEX)!.resourceSpans![0] as OtlpResourceSpan;
    expect(second.scopeSpans![0]!.spans).toEqual([otherSpan]);
  });

  test("partitions log records by trace id and keys base64 ids as hex", () => {
    const partitions = partitionByTraceId({
      resourceLogs: [
        {
          scopeLogs: [
            {
              scope: {},
              logRecords: [{ traceId: TRACE_ID_B64 }, { traceId: OTHER_TRACE_HEX }],
            },
          ],
        },
      ],
    });

    expect([...partitions.keys()].sort()).toEqual([TRACE_ID_HEX, OTHER_TRACE_HEX]);
  });

  test("drops spans without a trace id and returns empty for empty payloads", () => {
    expect(partitionByTraceId({}).size).toBe(0);
    const partitions = partitionByTraceId({
      resourceSpans: [resourceSpan({ spans: [{ name: "orphan" }] })],
    });
    expect(partitions.size).toBe(0);
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

describe("helpers", () => {
  test("nanoToMs converts and handles absence", () => {
    expect(nanoToMs("1700000000123456789")).toBe(1700000000123);
    expect(nanoToMs(undefined)).toBe(0);
  });

  test("hexFromB64OrString accepts hex, base64, and empty", () => {
    expect(hexFromB64OrString(TRACE_ID_HEX.toUpperCase())).toBe(TRACE_ID_HEX);
    expect(hexFromB64OrString(TRACE_ID_B64)).toBe(TRACE_ID_HEX);
    expect(hexFromB64OrString(undefined)).toBe("");
  });

  test("flattenAttributes handles typed values, arrays, and kvlist, empty for none", () => {
    expect(
      flattenAttributes([
        { key: "s", value: { stringValue: "x" } },
        { key: "i", value: { intValue: "42" } },
        { key: "d", value: { doubleValue: 1.5 } },
        { key: "b", value: { boolValue: true } },
        { key: "a", value: { arrayValue: { values: [{ stringValue: "y" }, { intValue: "7" }] } } },
        {
          key: "kv",
          value: { kvlistValue: { values: [{ key: "inner", value: { intValue: "3" } }] } },
        },
        { key: "skipped" },
      ]),
    ).toEqual({ s: "x", i: 42, d: 1.5, b: true, a: ["y", 7], kv: { inner: 3 } });
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
