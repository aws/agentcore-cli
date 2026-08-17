import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceStore } from "./store";
import type { OtlpPayload } from "./types";

const TRACE_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TRACE_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

export function payload(
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
  test("append then read returns the raw trace", async () => {
    await store.append(payload(TRACE_A));
    const trace = await store.read(TRACE_A);
    expect(trace?.resourceSpans).toHaveLength(1);
    expect(trace?.resourceLogs).toEqual([]);
  });

  test("appends to the same trace accumulate", async () => {
    await store.append(payload(TRACE_A));
    await store.append(payload(TRACE_A, { name: "tool_use" }));
    const trace = await store.read(TRACE_A);
    expect(trace?.resourceSpans).toHaveLength(2);
  });

  test("payloads without a trace id are dropped", async () => {
    await store.append({ resourceSpans: [] });
    expect(await store.readAll()).toEqual([]);
  });

  test("a batch carrying several traces lands in each trace's own file", async () => {
    const batch = payload(TRACE_A);
    batch.resourceSpans![0]!.scopeSpans![0]!.spans!.push({
      ...batch.resourceSpans![0]!.scopeSpans![0]!.spans![0]!,
      traceId: TRACE_B,
      name: "tool_use",
    });
    await store.append(batch);

    expect((await readdir(directory)).sort()).toEqual([
      `${TRACE_A}.otlp.jsonl`,
      `${TRACE_B}.otlp.jsonl`,
    ]);
    expect((await store.read(TRACE_B))?.resourceSpans).toHaveLength(1);
    expect(await store.readAll()).toHaveLength(2);
  });

  test("read of an unknown trace returns undefined", async () => {
    expect(await store.read(TRACE_A)).toBeUndefined();
  });

  test("skips malformed lines without failing", async () => {
    await store.append(payload(TRACE_A));
    await writeFile(join(directory, `${TRACE_A}.otlp.jsonl`), "{not json}\n", { flag: "a" });

    const trace = await store.read(TRACE_A);
    expect(trace?.resourceSpans).toHaveLength(1);
  });

  test("readAll on a directory that does not exist returns empty", async () => {
    const empty = new TraceStore(join(directory, "missing"));
    expect(await empty.readAll()).toEqual([]);
  });
});
