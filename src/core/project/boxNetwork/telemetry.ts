/**
 * Reads the CloudWatch targets of a box profile from the `[telemetry.<name>]` tables of the
 * `box.toml` that Box resolves it to. On AgentCore Runtime, Box signs each CloudWatch target with
 * the execution role, so build grants that role what these targets send.
 */

/** A CloudWatch target of the box profile, as Box sends to it. */
export type CloudWatchTelemetry =
  | {
      /** Log records, to CloudWatch Logs' OTLP endpoint in `region`. */
      readonly kind: "cloudwatch_logs";
      readonly region: string;
      readonly logGroup: string;
      readonly logStream: string;
    }
  | {
      /** Spans, to X-Ray's OTLP endpoint in `region`. */
      readonly kind: "cloudwatch_traces";
      readonly region: string;
    };

/** The longest log group or log stream name CloudWatch Logs accepts, as Box checks it. */
const MAXIMUM_LOG_NAME = 512;

/** An AWS region, as Box checks it: lower-case letters, digits, and `-`. */
const REGION = /^[a-z0-9-]{1,32}$/;

/** A log group name, as Box checks it: letters, digits, `.`, `_`, `-`, `/`, and `#`. */
const LOG_GROUP = /^[A-Za-z0-9._\-/#]+$/;

/** A log stream name, as Box checks it: no `:`, `*`, or control character. */
// oxlint-disable-next-line no-control-regex -- the control characters are what the check refuses
const NOT_IN_LOG_STREAM = /[:*\u0000-\u001f\u007f-\u009f]/;

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The trimmed string `value`, or undefined when it is not a string. */
const text = (value: unknown) => (typeof value === "string" ? value.trim() : undefined);

/**
 * The CloudWatch targets of the `[telemetry]` tables of `boxToml`, in profile order. A target that
 * Box would refuse (no region, or a group or stream name CloudWatch does not take) is left out, so
 * it gets no grant: Box stops the run that declares it.
 */
export function cloudWatchTelemetry(
  boxToml: Readonly<Record<string, unknown>>,
): CloudWatchTelemetry[] {
  const tables = isTable(boxToml.telemetry) ? Object.values(boxToml.telemetry) : [];
  const targets: CloudWatchTelemetry[] = [];
  for (const entry of tables) {
    if (!isTable(entry)) continue;
    const region = text(entry.region);
    if (region === undefined || !REGION.test(region)) continue;
    if (entry.kind === "cloudwatch_traces") {
      targets.push({ kind: "cloudwatch_traces", region });
      continue;
    }
    if (entry.kind !== "cloudwatch_logs") continue;
    const logGroup = text(entry.log_group);
    const logStream = text(entry.log_stream);
    const named = (name: string | undefined): name is string =>
      name !== undefined && name.length > 0 && name.length <= MAXIMUM_LOG_NAME;
    if (!named(logGroup) || !LOG_GROUP.test(logGroup)) continue;
    if (!named(logStream) || NOT_IN_LOG_STREAM.test(logStream)) continue;
    targets.push({ kind: "cloudwatch_logs", region, logGroup, logStream });
  }
  return targets;
}
