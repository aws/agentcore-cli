import { describe, expect, test } from "bun:test";
import type { CoreOptions } from "../types";
import { ObservabilityClient, type LogRecord } from "./client";
import type { LogSource, ObservabilitySourceResolverRegistry } from "./resolver";
import type {
  InsightsQuery,
  LogSearchQuery,
  LogTailQuery,
  RawLogRecord,
  SourceReader,
} from "./sourceReader";

const SOURCE: LogSource = {
  provider: "cloudwatch",
  logGroupName: "/aws/runtime-1",
};
const OPTIONS = { region: "us-east-1" };

async function collect(records: AsyncIterable<LogRecord>) {
  const result: LogRecord[] = [];
  for await (const record of records) result.push(record);
  return result;
}

function createClient(rawRecords: RawLogRecord[]) {
  const calls: { method: string; args: unknown[] }[] = [];
  const resolvers: ObservabilitySourceResolverRegistry = {
    runtime: {
      resolve: async (...args) => {
        calls.push({ method: "resolve", args });
        return {
          resource: {
            kind: "runtime",
            id: args[0].id,
            qualifier: args[0].qualifier ?? "DEFAULT",
          },
          logs: [SOURCE],
        };
      },
    },
  };
  const reader: SourceReader = {
    async *searchLogs(
      source: LogSource,
      query: LogSearchQuery,
      options: CoreOptions,
      signal?: AbortSignal,
    ) {
      calls.push({
        method: "searchLogs",
        args: [source, query, options, signal],
      });
      yield* rawRecords;
    },
    async *tailLogs(
      source: LogSource,
      query: LogTailQuery,
      options: CoreOptions,
      signal: AbortSignal,
    ) {
      calls.push({
        method: "tailLogs",
        args: [source, query, options, signal],
      });
      yield* rawRecords;
    },
    async *readLogStream() {
      yield* rawRecords;
    },
    async queryLogs(
      source: LogSource,
      query: InsightsQuery,
      options: CoreOptions,
      signal?: AbortSignal,
    ) {
      calls.push({
        method: "queryLogs",
        args: [source, query, options, signal],
      });
      return [{ traceId: "trace-1" }];
    },
  };
  return { client: new ObservabilityClient(resolvers, reader), calls };
}

describe("ObservabilityClient", () => {
  test("resolves, reads, and normalizes common log metadata", async () => {
    const raw = {
      timestamp: 1_709_391_000_000,
      ingestionTime: 1_709_391_000_100,
      logStreamName: "runtime-stream",
      message: JSON.stringify({
        traceId: "trace-1",
        spanId: "span-1",
        parentSpanId: "parent-1",
        severityText: "INFO",
        attributes: { "session.id": "session-1" },
      }),
      raw: { eventId: "event-1" },
    };
    const { client, calls } = createClient([raw]);
    const signal = new AbortController().signal;
    const query = { startTimeMs: 1, endTimeMs: 2 };

    const records = await collect(
      client.searchLogs(
        { kind: "runtime", id: "runtime-1", qualifier: "blue" },
        query,
        OPTIONS,
        signal,
      ),
    );

    expect(calls.map((call) => call.method)).toEqual(["resolve", "searchLogs"]);
    expect(records).toEqual([
      {
        timestamp: new Date(1_709_391_000_000),
        ingestionTime: new Date(1_709_391_000_100),
        message: raw.message,
        correlation: {
          traceId: "trace-1",
          spanId: "span-1",
          parentSpanId: "parent-1",
          sessionId: "session-1",
        },
        severity: "INFO",
        source: {
          provider: "cloudwatch",
          resource: {
            kind: "runtime",
            id: "runtime-1",
            qualifier: "blue",
          },
          logGroupName: SOURCE.logGroupName,
          logStreamName: "runtime-stream",
        },
        raw: { eventId: "event-1" },
      },
    ]);
  });

  test("uses the same orchestration path for Live Tail records", async () => {
    const { client, calls } = createClient([
      {
        timestamp: 1,
        message: "plain text",
        raw: { message: "plain text" },
      },
    ]);
    const signal = new AbortController().signal;

    const records = await collect(
      client.tailLogs(
        { kind: "runtime", id: "runtime-1" },
        { filterPattern: "ERROR" },
        OPTIONS,
        signal,
      ),
    );

    expect(calls.map((call) => call.method)).toEqual(["resolve", "tailLogs"]);
    expect(records[0]).not.toHaveProperty("correlation");
    expect(records[0]).not.toHaveProperty("severity");
  });

  test("resolves resources before executing generic queries", async () => {
    const { client, calls } = createClient([]);
    const query = {
      queryString: "fields traceId",
      startTimeMs: 1_000,
      endTimeMs: 2_000,
    };

    await expect(
      client.queryLogs({ kind: "runtime", id: "runtime-1", qualifier: "blue" }, query, OPTIONS),
    ).resolves.toEqual([{ traceId: "trace-1" }]);
    expect(calls.map((call) => call.method)).toEqual(["resolve", "queryLogs"]);
    expect(calls[1]!.args[1]).toBe(query);
  });
});
