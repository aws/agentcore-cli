import { describe, expect, test } from "bun:test";
import { cloudWatchTelemetry, thirdPartyTelemetry, withDeployRegion } from "./telemetry";

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
  const PROFILE = ".box/agent/local/profile.toml";
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

describe("thirdPartyTelemetry", () => {
  const LANGSMITH = {
    kind: "langsmith",
    project: "box",
    include: ["trace"],
    secret: { ref: "env://LANGSMITH_KEY" },
  };

  test("reads a target's key variable and each key Box takes, and no file or CloudWatch target", () => {
    const telemetry = {
      records: { kind: "file", destination: "/tmp/records.jsonl" },
      langsmith: LANGSMITH,
      logs: { ...LOGS },
      collector: {
        kind: "otlp",
        destination: "https://collector.example.com/otlp",
        accepts: ["traces", "logs"],
        headers: { "x-team": "box" },
        secret: { ref: "secret://COLLECTOR_TOKEN", header: "x-api-key", prefix: "Key " },
      },
    };

    expect(thirdPartyTelemetry({ telemetry })).toEqual({
      targets: [
        {
          name: "langsmith",
          kind: "langsmith",
          keys: [
            ["project", "box"],
            ["include", ["trace"]],
          ],
          secret: { variable: "LANGSMITH_KEY", keys: [] },
        },
        {
          name: "collector",
          kind: "otlp",
          keys: [
            ["destination", "https://collector.example.com/otlp"],
            ["accepts", ["traces", "logs"]],
            ["headers", { "x-team": "box" }],
          ],
          secret: {
            variable: "COLLECTOR_TOKEN",
            keys: [
              ["header", "x-api-key"],
              ["prefix", "Key "],
            ],
          },
        },
      ],
      leftOut: [],
    });
  });

  test("reads a target with no key, which needs no secret", () => {
    const collector = { kind: "otlp", destination: "https://collector.example.com" };

    expect(thirdPartyTelemetry({ telemetry: { collector } }).targets).toEqual([
      {
        name: "collector",
        kind: "otlp",
        keys: [["destination", "https://collector.example.com"]],
      },
    ]);
  });

  test.each([
    ["an aws:// profile", "aws://my-profile"],
    ["a credsd:// environment", "credsd://work"],
    ["a Secrets Manager secret", "aws-secretsmanager://box/telemetry#KEY"],
    ["no variable", "env://"],
    ["a variable with a -", "env://MY-KEY"],
  ])("leaves out a target whose key names %s, and says why", (_label, ref) => {
    const telemetry = { langsmith: { ...LANGSMITH, secret: { ref } } };

    expect(thirdPartyTelemetry({ telemetry })).toEqual({
      targets: [],
      leftOut: [
        {
          name: "langsmith",
          reason:
            "its `secret.ref` names no `env://` or `secret://` variable, and build moves only " +
            "such a key to AWS Secrets Manager",
          fix: "Set `secret.ref` to an `env://` or `secret://` variable",
        },
      ],
    });
  });

  test.each([
    ["a /", "team/langsmith"],
    ["a space", "lang smith"],
    ["129 characters", "k".repeat(129)],
  ])(
    "leaves out a target with a key whose name has %s, as it cannot name a variable",
    (_label, name) => {
      const { targets, leftOut } = thirdPartyTelemetry({ telemetry: { [name]: LANGSMITH } });

      expect(targets).toEqual([]);
      expect(leftOut.map((target) => target.name)).toEqual([name]);
      expect(leftOut[0]?.reason).toContain("cannot name the variable deploy reads its key from");
      expect(leftOut[0]?.fix).toBe("Rename the target");
    },
  );

  test("leaves out a target with a key that build cannot copy", () => {
    const telemetry = { langsmith: { ...LANGSMITH, include: [1] } };

    expect(thirdPartyTelemetry({ telemetry }).leftOut).toEqual([
      { name: "langsmith", reason: "Box resolves its `include` to a value build cannot copy" },
    ]);
  });

  test("reads nothing from a box.toml with no telemetry table", () => {
    expect(thirdPartyTelemetry({})).toEqual({ targets: [], leftOut: [] });
  });
});
