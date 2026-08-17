import { describe, expect, test } from "bun:test";
import { hexFromB64OrString, nanoToMs, partitionByTraceId } from "./transforms";
import type { OtlpResourceSpan } from "./types";

const TRACE_ID_HEX = "0123456789abcdef0123456789abcdef";
const TRACE_ID_B64 = Buffer.from(TRACE_ID_HEX, "hex").toString("base64");
const OTHER_TRACE_HEX = "ffffffffffffffffffffffffffffffff";

function resourceSpan(spans: object[]): OtlpResourceSpan {
  return {
    resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }] },
    scopeSpans: [{ scope: { name: "test-scope" }, spans }],
  };
}

const agentSpan = { traceId: TRACE_ID_B64, spanId: "0123456789abcdef", name: "invoke_agent" };

describe("partitionByTraceId", () => {
  test("splits a batch carrying several traces into per-trace payloads", () => {
    const otherSpan = { ...agentSpan, traceId: OTHER_TRACE_HEX, name: "tool_use" };
    const partitions = partitionByTraceId({
      resourceSpans: [resourceSpan([agentSpan, otherSpan])],
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
            { scope: {}, logRecords: [{ traceId: TRACE_ID_B64 }, { traceId: OTHER_TRACE_HEX }] },
          ],
        },
      ],
    });

    expect([...partitions.keys()].sort()).toEqual([TRACE_ID_HEX, OTHER_TRACE_HEX]);
  });

  test("drops spans without a trace id and returns empty for empty payloads", () => {
    expect(partitionByTraceId({}).size).toBe(0);
    expect(partitionByTraceId({ resourceSpans: [resourceSpan([{ name: "orphan" }])] }).size).toBe(
      0,
    );
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
});
