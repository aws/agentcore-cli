import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ProjectSpec } from "../../projectSchemas/project";
import type { CloudWatchTelemetry } from "./boxNetwork";
import {
  BOX_TELEMETRY_POLICY_FILE,
  boxTelemetryPolicy,
  placeBoxTelemetryPolicy,
} from "./boxTelemetry";

const LOGS: CloudWatchTelemetry = {
  kind: "cloudwatch_logs",
  region: "us-west-2",
  logGroup: "my-group",
  logStream: "my-stream",
};
const TRACES: CloudWatchTelemetry = { kind: "cloudwatch_traces", region: "us-west-2" };

const LOGS_STATEMENT = {
  Sid: "BoxTelemetryToCloudWatchLogs",
  Effect: "Allow",
  Action: ["logs:PutLogEvents"],
  Resource: ["arn:aws:logs:us-west-2:*:log-group:my-group:log-stream:my-stream"],
};
const TRACES_STATEMENT = {
  Sid: "BoxTelemetryToXRay",
  Effect: "Allow",
  Action: ["xray:PutSpans"],
  Resource: "*",
};

describe("boxTelemetryPolicy", () => {
  test("lets a cloudwatch_logs target put log events in its own group and stream only", () => {
    expect(boxTelemetryPolicy([LOGS])).toEqual({
      Version: "2012-10-17",
      Statement: [LOGS_STATEMENT],
    });
  });

  test("lets a cloudwatch_traces target put spans, which has no resource type", () => {
    expect(boxTelemetryPolicy([TRACES])).toEqual({
      Version: "2012-10-17",
      Statement: [TRACES_STATEMENT],
    });
  });

  test("has one statement for each kind when the profile sends both", () => {
    expect(boxTelemetryPolicy([TRACES, LOGS])).toEqual({
      Version: "2012-10-17",
      Statement: [LOGS_STATEMENT, TRACES_STATEMENT],
    });
  });

  test("lists each log stream once, with the partition of its region", () => {
    const china = { ...LOGS, region: "cn-north-1" };
    const govCloud = { ...LOGS, region: "us-gov-west-1", logStream: "other" };
    const policy = boxTelemetryPolicy([LOGS, china, LOGS, govCloud, TRACES, TRACES]);
    expect(policy?.Statement).toEqual([
      {
        ...LOGS_STATEMENT,
        Resource: [
          "arn:aws:logs:us-west-2:*:log-group:my-group:log-stream:my-stream",
          "arn:aws-cn:logs:cn-north-1:*:log-group:my-group:log-stream:my-stream",
          "arn:aws-us-gov:logs:us-gov-west-1:*:log-group:my-group:log-stream:other",
        ],
      },
      TRACES_STATEMENT,
    ]);
  });

  test("is undefined with no CloudWatch target", () => {
    expect(boxTelemetryPolicy([])).toBeUndefined();
  });
});

const ROOT = "/project";

function specWith(runtimes: Record<string, unknown>[]): ProjectSpec {
  return { runtimes } as unknown as ProjectSpec;
}

const agent = (rest: Record<string, unknown> = {}) => ({
  name: "agent",
  codeLocation: "app/agent",
  ...rest,
});

describe("placeBoxTelemetryPolicy", () => {
  test("lists the file from the runtime's codeLocation, where the CDK library reads it", () => {
    const spec = specWith([agent({ additionalPolicies: ["mine.json"] })]);

    expect(placeBoxTelemetryPolicy(spec, ROOT, ["agent"])).toEqual([
      `adding ${BOX_TELEMETRY_POLICY_FILE} to additionalPolicies of 'agent', so its box can ` +
        "send telemetry to CloudWatch",
    ]);
    const [, entry] = spec.runtimes[0]!.additionalPolicies!;
    expect(spec.runtimes[0]!.additionalPolicies).toEqual([
      "mine.json",
      "../../agentcore/box-telemetry-policy.json",
    ]);
    expect(resolve(ROOT, "app/agent", entry!)).toBe(resolve(ROOT, BOX_TELEMETRY_POLICY_FILE));
  });

  test("changes nothing when the runtime lists the file already", () => {
    const listed = ["../../agentcore/box-telemetry-policy.json"];
    const spec = specWith([agent({ additionalPolicies: listed })]);
    expect(placeBoxTelemetryPolicy(spec, ROOT, ["agent"])).toEqual([]);
    expect(spec.runtimes[0]!.additionalPolicies).toEqual(listed);
  });

  test("gives no entry to a runtime that imports its role", () => {
    const spec = specWith([agent({ executionRoleArn: "arn:aws:iam::123456789012:role/mine" })]);
    expect(placeBoxTelemetryPolicy(spec, ROOT, ["agent"])).toEqual([]);
    expect(spec.runtimes[0]!.additionalPolicies).toBeUndefined();
  });

  test("removes the entry from a runtime whose box sends no CloudWatch telemetry, and keeps the user's", () => {
    const spec = specWith([
      agent({ additionalPolicies: ["mine.json", "../../agentcore/box-telemetry-policy.json"] }),
      agent({ name: "other", additionalPolicies: ["../../agentcore/box-telemetry-policy.json"] }),
    ]);

    expect(placeBoxTelemetryPolicy(spec, ROOT, [])).toEqual([
      `removing ${BOX_TELEMETRY_POLICY_FILE} from additionalPolicies of 'agent': its box ` +
        "sends no telemetry to CloudWatch",
      `removing ${BOX_TELEMETRY_POLICY_FILE} from additionalPolicies of 'other': its box ` +
        "sends no telemetry to CloudWatch",
    ]);
    expect(spec.runtimes[0]!.additionalPolicies).toEqual(["mine.json"]);
    expect(spec.runtimes[1]!.additionalPolicies).toBeUndefined();
  });

  test("keeps a user file of the same name elsewhere", () => {
    const spec = specWith([agent({ additionalPolicies: ["box-telemetry-policy.json"] })]);
    expect(placeBoxTelemetryPolicy(spec, ROOT, [])).toEqual([]);
    expect(spec.runtimes[0]!.additionalPolicies).toEqual(["box-telemetry-policy.json"]);
  });
});
