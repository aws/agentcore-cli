import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceStore } from "./store";
import type { OtlpPayload } from "./types";

const TRACE_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TRACE_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function payload(
  traceId: string,
  options: { serviceName?: string; startNano?: string; name?: string } = {},
): OtlpPayload {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: options.serviceName ?? "agent-1" } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "test" },
            spans: [
              {
                traceId,
                spanId: "0123456789abcdef",
                name: options.name ?? "invoke_agent strands",
                kind: 1,
                startTimeUnixNano: options.startNano ?? `${BigInt(Date.now()) * 1_000_000n}`,
                endTimeUnixNano: options.startNano ?? `${BigInt(Date.now()) * 1_000_000n}`,
              },
            ],
          },
        ],
      },
    ],
  };
}

let directory: string;
let store: TraceStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "trace-store-"));
  store = new TraceStore(directory);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("TraceStore", () => {
  test("append then list returns the trace with metadata", async () => {
    await store.append(payload(TRACE_A));
    const traces = await store.list();
    expect(traces).toHaveLength(1);
    expect(traces[0]!.traceId).toBe(TRACE_A);
    expect(traces[0]!.spanCount).toBe("1");
    expect(traces[0]!.resourceSpans).toBeDefined();
  });

  test("appends to the same trace accumulate spans", async () => {
    await store.append(payload(TRACE_A));
    await store.append(payload(TRACE_A, { name: "tool_use" }));
    const traces = await store.list();
    expect(traces).toHaveLength(1);
    expect(traces[0]!.spanCount).toBe("2");
  });

  test("payloads without a trace id are dropped", async () => {
    await store.append({ resourceSpans: [] });
    expect(await store.list()).toEqual([]);
  });

  test("a batch carrying several traces lands in each trace's own file", async () => {
    const batch = payload(TRACE_A);
    batch.resourceSpans![0]!.scopeSpans![0]!.spans!.push({
      ...batch.resourceSpans![0]!.scopeSpans![0]!.spans![0]!,
      traceId: TRACE_B,
      name: "tool_use",
    });
    await store.append(batch);

    const traces = await store.list();
    expect(traces.map((trace) => trace.traceId).sort()).toEqual([TRACE_A, TRACE_B]);
    expect(traces.every((trace) => trace.spanCount === "1")).toBe(true);
    expect(await store.get(TRACE_B)).toBeDefined();
  });

  test("list filters by service name, matching every participant of a distributed trace", async () => {
    await store.append(payload(TRACE_A, { serviceName: "agent-1" }));
    // agent-2 contributes spans to the SAME trace (distributed) and owns its own trace.
    await store.append(payload(TRACE_A, { serviceName: "agent-2", name: "tool_use" }));
    await store.append(payload(TRACE_B, { serviceName: "agent-2" }));

    expect((await store.list({ serviceName: "agent-2" })).map((t) => t.traceId).sort()).toEqual([
      TRACE_A,
      TRACE_B,
    ]);
    expect((await store.list({ serviceName: "agent-1" })).map((t) => t.traceId)).toEqual([TRACE_A]);
    expect(await store.list({ serviceName: "agent-3" })).toEqual([]);
  });

  test("list filters by time window and sorts newest first", async () => {
    const oldNano = `${BigInt(Date.now() - 24 * 60 * 60 * 1000) * 1_000_000n}`;
    await store.append(payload(TRACE_A, { startNano: oldNano }));
    await store.append(payload(TRACE_B));

    expect((await store.list()).map((trace) => trace.traceId)).toEqual([TRACE_B]);

    const all = await store.list({ startTime: 0 });
    expect(all.map((trace) => trace.traceId)).toEqual([TRACE_B, TRACE_A]);
  });

  test("get returns the trace detail or undefined for unknown ids", async () => {
    await store.append(payload(TRACE_A));
    const detail = await store.get(TRACE_A);
    expect(detail?.resourceSpans).toBeDefined();
    expect(await store.get(TRACE_B)).toBeUndefined();
  });

  test("skips malformed lines and files without failing", async () => {
    await store.append(payload(TRACE_A));
    await writeFile(join(directory, `${TRACE_A}.otlp.jsonl`), "{not json}\n", {
      flag: "a",
    });
    await writeFile(join(directory, "garbage.otlp.jsonl"), "also not json\n");

    const traces = await store.list();
    expect(traces).toHaveLength(1);
    expect(traces[0]!.spanCount).toBe("1");
  });

  test("list on a directory that does not exist returns empty", async () => {
    const empty = new TraceStore(join(directory, "missing"));
    expect(await empty.list()).toEqual([]);
    expect(await empty.get(TRACE_A)).toBeUndefined();
  });
});
