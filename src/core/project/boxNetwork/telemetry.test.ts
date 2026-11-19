import { describe, expect, test } from "bun:test";
import { cloudWatchTelemetry } from "./telemetry";

const LOGS = {
  kind: "cloudwatch_logs",
  region: "us-west-2",
  log_group: "my-group",
  log_stream: "my-stream",
  secret: { ref: "aws://my-profile" },
};
const TRACES = {
  kind: "cloudwatch_traces",
  region: "us-east-1",
  secret: { ref: "aws://my-profile" },
};

describe("cloudWatchTelemetry", () => {
  test("reads a cloudwatch_logs table: its region, group, and stream", () => {
    expect(cloudWatchTelemetry({ telemetry: { logs: LOGS } })).toEqual([
      {
        name: "logs",
        kind: "cloudwatch_logs",
        region: "us-west-2",
        logGroup: "my-group",
        logStream: "my-stream",
      },
    ]);
  });

  test("reads a cloudwatch_traces table: its region", () => {
    expect(cloudWatchTelemetry({ telemetry: { traces: TRACES } })).toEqual([
      { name: "traces", kind: "cloudwatch_traces", region: "us-east-1" },
    ]);
  });

  test("reads both kinds in profile order, and no other kind", () => {
    const telemetry = {
      langfuse: { kind: "langfuse", secret: { ref: "env://LANGFUSE_AUTH" } },
      traces: TRACES,
      otlp: { kind: "otlp", destination: "https://collector.example.com" },
      logs: LOGS,
    };
    expect(cloudWatchTelemetry({ telemetry }).map(({ kind }) => kind)).toEqual([
      "cloudwatch_traces",
      "cloudwatch_logs",
    ]);
  });

  test("trims the region, group, and stream, as Box does", () => {
    const logs = { ...LOGS, region: " us-west-2 ", log_group: " /aws/box ", log_stream: " run " };
    expect(cloudWatchTelemetry({ telemetry: { logs } })).toEqual([
      {
        name: "logs",
        kind: "cloudwatch_logs",
        region: "us-west-2",
        logGroup: "/aws/box",
        logStream: "run",
      },
    ]);
  });

  test.each([
    ["a group with *", { log_group: "my-*" }],
    ["a group with a space", { log_group: "my group" }],
    ["a stream with *", { log_stream: "*" }],
    ["a stream with :", { log_stream: "a:b" }],
    ["no stream", { log_stream: undefined }],
    ["a group longer than 512", { log_group: "g".repeat(513) }],
    ["an upper-case region", { region: "US-WEST-2" }],
    ["no region", { region: undefined }],
    ["an empty region", { region: " " }],
    ["a region that is not a string", { region: 2 }],
  ])("leaves out a cloudwatch_logs target that Box refuses: %s", (_label, change) => {
    expect(cloudWatchTelemetry({ telemetry: { logs: { ...LOGS, ...change } } })).toEqual([]);
  });

  test("reads the name of each table, and its include", () => {
    const telemetry = { audit: { ...TRACES, include: ["deny", "trace"] }, logs: LOGS };
    expect(cloudWatchTelemetry({ telemetry }).map(({ name, include }) => [name, include])).toEqual([
      ["audit", ["deny", "trace"]],
      ["logs", undefined],
    ]);
  });

  test.each([
    ["an empty include", []],
    ["a repeated word", ["logs", "logs"]],
    ["a word Box does not take", ["spans"]],
    ["a string", "logs"],
  ])("leaves out a target with an include that Box refuses: %s", (_label, include) => {
    expect(cloudWatchTelemetry({ telemetry: { logs: { ...LOGS, include } } })).toEqual([]);
    expect(cloudWatchTelemetry({ telemetry: { traces: { ...TRACES, include } } })).toEqual([]);
  });

  test("reads nothing from a box.toml with no telemetry table", () => {
    expect(cloudWatchTelemetry({})).toEqual([]);
    expect(cloudWatchTelemetry({ telemetry: "logs" })).toEqual([]);
  });
});
