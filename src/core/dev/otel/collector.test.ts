import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExportLogsServiceRequest,
  ExportTraceServiceRequest,
  type OtelCollector,
  startOtelCollector,
} from "./collector";

const TRACE_ID_HEX = "0123456789abcdef0123456789abcdef";

function protobufTracePayload(): Uint8Array {
  const message = ExportTraceServiceRequest.fromObject({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "proto-agent" } }] },
        scopeSpans: [
          {
            scope: { name: "test" },
            spans: [
              {
                traceId: Buffer.from(TRACE_ID_HEX, "hex"),
                spanId: Buffer.from("0123456789abcdef", "hex"),
                name: "invoke_agent strands",
                kind: 1,
                startTimeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
                endTimeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
              },
            ],
          },
        ],
      },
    ],
  });
  return ExportTraceServiceRequest.encode(message).finish();
}

function protobufLogsPayload(): Uint8Array {
  const message = ExportLogsServiceRequest.fromObject({
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "proto-agent" } }] },
        scopeLogs: [
          {
            scope: { name: "test" },
            logRecords: [
              {
                traceId: Buffer.from(TRACE_ID_HEX, "hex"),
                timeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
                body: { stringValue: "a log line" },
              },
            ],
          },
        ],
      },
    ],
  });
  return ExportLogsServiceRequest.encode(message).finish();
}

let directory: string;
let collector: OtelCollector;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "otel-collector-"));
  collector = await startOtelCollector({ tracesDirectory: directory });
});

afterEach(async () => {
  await collector.close();
  await rm(directory, { recursive: true, force: true });
});

function post(
  path: string,
  body: string | Uint8Array,
  contentType = "application/x-protobuf",
): Promise<Response> {
  return fetch(`http://127.0.0.1:${collector.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
}

describe("startOtelCollector", () => {
  test("ingests protobuf trace exports and serves them back through the store", async () => {
    const response = await post("/v1/traces", protobufTracePayload());
    expect(response.status).toBe(200);

    const traces = await collector.store.list();
    expect(traces).toHaveLength(1);
    expect(traces[0]!.traceId).toBe(TRACE_ID_HEX);
  });

  test("ingests protobuf log exports into the same trace", async () => {
    await post("/v1/traces", protobufTracePayload());
    const response = await post("/v1/logs", protobufLogsPayload());
    expect(response.status).toBe(200);

    const detail = await collector.store.get(TRACE_ID_HEX);
    expect(detail?.resourceLogs).toBeDefined();
  });

  test("ingests JSON trace exports", async () => {
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "json-agent" } }] },
          scopeSpans: [
            {
              scope: { name: "test" },
              spans: [
                {
                  traceId: TRACE_ID_HEX,
                  spanId: "0123456789abcdef",
                  name: "invoke_agent strands",
                  kind: 1,
                  startTimeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
                  endTimeUnixNano: `${BigInt(Date.now()) * 1_000_000n}`,
                },
              ],
            },
          ],
        },
      ],
    });
    const response = await post("/v1/traces", body, "application/json");
    expect(response.status).toBe(200);
    expect((await collector.store.list()).map((trace) => trace.traceId)).toEqual([TRACE_ID_HEX]);
  });

  test("rejects malformed payloads with 400", async () => {
    expect((await post("/v1/traces", "not json", "application/json")).status).toBe(400);
    expect((await post("/v1/traces", Buffer.from([0xff, 0xff, 0xff]))).status).toBe(400);
    expect(await collector.store.list()).toEqual([]);
  });

  test.each(["null", "[]", "42", '{"resourceSpans":5}'])(
    "rejects structurally invalid JSON %s with 400 instead of a persistence error",
    async (body) => {
      const errors: unknown[] = [];
      const strict = await startOtelCollector({
        tracesDirectory: directory,
        onError: (error) => errors.push(error),
      });
      try {
        const response = await fetch(`http://127.0.0.1:${strict.port}/v1/traces`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        expect(response.status).toBe(400);
        expect(errors).toEqual([]);
        expect(await strict.store.list()).toEqual([]);
      } finally {
        await strict.close();
      }
    },
  );

  test("acks with 200 and reports onError when persistence fails", async () => {
    // A traces dir nested under a regular file makes mkdir (and thus append) fail.
    const blocker = join(directory, "blocker");
    await writeFile(blocker, "x");
    const errors: unknown[] = [];
    const failing = await startOtelCollector({
      tracesDirectory: join(blocker, "otlp"),
      onError: (error) => errors.push(error),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${failing.port}/v1/traces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: TRACE_ID_HEX, name: "x" }] }] }],
        }),
      });
      // Exporter must see success so it stops retrying; the failure is reported instead.
      expect(response.status).toBe(200);
      expect(errors).toHaveLength(1);
    } finally {
      await failing.close();
    }
  });

  test("health check responds ok and unknown routes 404", async () => {
    const health = await fetch(`http://127.0.0.1:${collector.port}/`);
    expect(await health.json()).toEqual({ status: "ok" });
    expect(
      (await fetch(`http://127.0.0.1:${collector.port}/v1/metrics`, { method: "POST" })).status,
    ).toBe(404);
  });

  test("envVars point the SDK at the collector, including signal-specific overrides", () => {
    const endpoint = `http://127.0.0.1:${collector.port}`;
    expect(collector.envVars).toMatchObject({
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${endpoint}/v1/traces`,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${endpoint}/v1/logs`,
      OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/protobuf",
      OTEL_METRICS_EXPORTER: "none",
    });
  });

  test("envVars force the settings that would otherwise break local collection", () => {
    expect(collector.envVars).toMatchObject({
      OTEL_SDK_DISABLED: "false",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_COMPRESSION: "none",
      OTEL_EXPORTER_OTLP_TRACES_COMPRESSION: "none",
      OTEL_EXPORTER_OTLP_LOGS_COMPRESSION: "none",
    });
  });

  test("abort signal closes the receiver", async () => {
    const controller = new AbortController();
    const aborted = await startOtelCollector({
      tracesDirectory: directory,
      signal: controller.signal,
    });
    controller.abort();
    await Bun.sleep(20);
    expect(fetch(`http://127.0.0.1:${aborted.port}/`)).rejects.toThrow();
  });
});
