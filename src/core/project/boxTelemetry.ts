import { relative, resolve, sep } from "node:path";
import { partition } from "@aws-sdk/util-endpoints";
import type { ProjectSpec } from "../../projectSchemas/project";
import type { ProjectRuntime } from "../../projectSchemas/runtime";
import type { CloudWatchTelemetry } from "./boxNetwork";

/**
 * The policy file, relative to the project root, that lets the execution role of each box runtime
 * send the box profile's CloudWatch telemetry. On AgentCore Runtime, Box signs each CloudWatch
 * target with that role. The CLI rewrites it on build, and removes it when the profile sends no
 * telemetry to CloudWatch.
 */
export const BOX_TELEMETRY_POLICY_FILE = "agentcore/box-telemetry-policy.json";

/**
 * The IAM policy document for {@link BOX_TELEMETRY_POLICY_FILE}, or undefined when no target sends
 * to CloudWatch. Build has no account, so each log stream ARN matches any account. CloudWatch Logs
 * takes OTLP records only into a group and a stream that exist, and X-Ray's `PutSpans` has no
 * resource type.
 */
export function boxTelemetryPolicy(
  telemetry: readonly CloudWatchTelemetry[],
): Record<string, unknown> | undefined {
  const streams = [
    ...new Set(
      telemetry.flatMap((target) =>
        target.kind === "cloudwatch_logs"
          ? [
              `arn:${partition(target.region).name}:logs:${target.region}:*:log-group:` +
                `${target.logGroup}:log-stream:${target.logStream}`,
            ]
          : [],
      ),
    ),
  ];
  const traces = telemetry.some(({ kind }) => kind === "cloudwatch_traces");
  const statements = [
    ...(streams.length > 0
      ? [
          {
            Sid: "BoxTelemetryToCloudWatchLogs",
            Effect: "Allow",
            Action: ["logs:PutLogEvents"],
            Resource: streams,
          },
        ]
      : []),
    ...(traces
      ? [{ Sid: "BoxTelemetryToXRay", Effect: "Allow", Action: ["xray:PutSpans"], Resource: "*" }]
      : []),
  ];
  return statements.length > 0 ? { Version: "2012-10-17", Statement: statements } : undefined;
}

/**
 * The `additionalPolicies` entry of `runtime` for {@link BOX_TELEMETRY_POLICY_FILE}. The CDK
 * library reads a runtime's policy files from its `codeLocation`, so the entry is relative to it.
 */
function telemetryEntry(projectRoot: string, runtime: ProjectRuntime): string {
  const from = resolve(projectRoot, runtime.codeLocation);
  return relative(from, resolve(projectRoot, BOX_TELEMETRY_POLICY_FILE)).split(sep).join("/");
}

/** Whether `entry` of the `additionalPolicies` of `runtime` names {@link BOX_TELEMETRY_POLICY_FILE}. */
function namesTelemetryPolicy(projectRoot: string, runtime: ProjectRuntime, entry: string) {
  return (
    !entry.startsWith("arn:") &&
    resolve(projectRoot, runtime.codeLocation, entry) ===
      resolve(projectRoot, BOX_TELEMETRY_POLICY_FILE)
  );
}

/**
 * Lists {@link BOX_TELEMETRY_POLICY_FILE} in the `additionalPolicies` of each runtime of `boxed`,
 * and removes it from every other runtime. A runtime that imports its role (`executionRoleArn`)
 * is the user's to grant, so it gets no entry. Changes `spec` in place, and returns the step
 * messages; none when nothing changed.
 */
export function placeBoxTelemetryPolicy(
  spec: ProjectSpec,
  projectRoot: string,
  boxed: readonly string[],
): string[] {
  const messages: string[] = [];
  for (const runtime of spec.runtimes) {
    const listed = runtime.additionalPolicies ?? [];
    const has = listed.some((entry) => namesTelemetryPolicy(projectRoot, runtime, entry));
    const wanted = boxed.includes(runtime.name) && !runtime.executionRoleArn;
    if (wanted && !has) {
      runtime.additionalPolicies = [...listed, telemetryEntry(projectRoot, runtime)];
      messages.push(
        `adding ${BOX_TELEMETRY_POLICY_FILE} to additionalPolicies of '${runtime.name}', so its ` +
          "box can send telemetry to CloudWatch",
      );
    } else if (!wanted && has) {
      const kept = listed.filter((entry) => !namesTelemetryPolicy(projectRoot, runtime, entry));
      runtime.additionalPolicies = kept.length > 0 ? kept : undefined;
      messages.push(
        `removing ${BOX_TELEMETRY_POLICY_FILE} from additionalPolicies of '${runtime.name}': ` +
          "its box sends no telemetry to CloudWatch",
      );
    }
  }
  return messages;
}
