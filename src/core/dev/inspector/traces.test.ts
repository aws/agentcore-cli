import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceStore } from "../otel/store";
import { payload } from "../otel/store.test";
import { InspectorTraceSource } from "./traces";

const TRACE_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TRACE_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

let directory: string;
let store: TraceStore;
let source: InspectorTraceSource;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "trace-source-"));
  store = new TraceStore(directory);
  source = new InspectorTraceSource(store);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("InspectorTraceSource", () => {
  test("lists traces with metadata and frontend-shaped detail", async () => {
    await store.append(payload(TRACE_A));
    const traces = await source.list();
    expect(traces).toHaveLength(1);
    expect(traces[0]!.traceId).toBe(TRACE_A);
    expect(traces[0]!.spanCount).toBe("1");
    expect(traces[0]!.resourceSpans).toBeDefined();
  });

  test("filters by service name", async () => {
    await store.append(payload(TRACE_A, { serviceName: "agent-1" }));
    await store.append(payload(TRACE_B, { serviceName: "agent-2" }));
    const traces = await source.list({ serviceName: "agent-2" });
    expect(traces.map((trace) => trace.traceId)).toEqual([TRACE_B]);
  });

  test("filters by time window and sorts newest first", async () => {
    const oldNano = `${BigInt(Date.now() - 24 * 60 * 60 * 1000) * 1_000_000n}`;
    await store.append(payload(TRACE_A, { startNano: oldNano }));
    await store.append(payload(TRACE_B));

    expect((await source.list()).map((trace) => trace.traceId)).toEqual([TRACE_B]);
    expect((await source.list({ startTime: 0 })).map((trace) => trace.traceId)).toEqual([
      TRACE_B,
      TRACE_A,
    ]);
  });

  test("get returns detail or undefined for unknown ids", async () => {
    await store.append(payload(TRACE_A));
    expect((await source.get(TRACE_A))?.resourceSpans).toBeDefined();
    expect(await source.get(TRACE_B)).toBeUndefined();
  });
});
