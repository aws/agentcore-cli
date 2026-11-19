import { describe, expect, test } from "bun:test";
import { cloudWatchTelemetry, withDeployRegion } from "./telemetry";

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
    ["an empty region", { region: " " }],
    ["a region that is not a string", { region: 2 }],
  ])("leaves out a cloudwatch_logs target that Box refuses: %s", (_label, change) => {
    expect(cloudWatchTelemetry({ telemetry: { logs: { ...LOGS, ...change } } })).toEqual([]);
  });

  test("reads a target with no region, with no region", () => {
    const { region: _logs, ...logs } = LOGS;
    const { region: _traces, ...traces } = TRACES;
    expect(cloudWatchTelemetry({ telemetry: { logs, traces } })).toEqual([
      { name: "logs", kind: "cloudwatch_logs", logGroup: "my-group", logStream: "my-stream" },
      { name: "traces", kind: "cloudwatch_traces" },
    ]);
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

describe("withDeployRegion", () => {
  const PROFILE = ".box/profile.toml";
  const logs = { name: "logs", kind: "cloudwatch_logs", logGroup: "g", logStream: "s" } as const;
  const traces = { name: "traces", kind: "cloudwatch_traces" } as const;

  test("sets the region on each target with none, and keeps a target's own region", () => {
    const own = { ...traces, name: "own", region: "eu-west-1" };
    expect(withDeployRegion([logs, own], "ap-south-1", PROFILE).telemetry).toEqual([
      { ...logs, region: "ap-south-1" },
      own,
    ]);
  });

  test("warns once that agentcore dev cannot run a profile with a target that has no region", () => {
    expect(withDeployRegion([logs, traces], "ap-south-1", PROFILE).warnings).toEqual([
      `${PROFILE}: [telemetry.logs] and [telemetry.traces] have no region, so the AgentCore ` +
        "Runtime profile and the telemetry policy get ap-south-1. Deploy sets the region of its " +
        "deploy target. Box refuses a CloudWatch target with no region, so `agentcore dev` " +
        "cannot run this profile until you add region to it.",
    ]);
    expect(withDeployRegion([{ ...logs, region: "us-west-2" }], "ap-south-1", PROFILE)).toEqual({
      telemetry: [{ ...logs, region: "us-west-2" }],
      warnings: [],
    });
  });
});
