/**
 * Reads the CloudWatch targets of a box profile from the `[telemetry.<name>]` tables of the
 * `box.toml` that Box resolves it to. On AgentCore Runtime, Box signs each CloudWatch target with
 * the execution role, so that role needs a grant for what these targets send.
 */

/** A CloudWatch target of the box profile, as Box sends to it. */
export type CloudWatchTelemetry = CloudWatchTarget & {
  /** The region of its OTLP endpoint. */
  readonly region: string;
};

/**
 * A CloudWatch target as the box profile names it. It has no `region` when the profile names none;
 * build and deploy then write the region of the deploy target in the AgentCore Runtime profile.
 */
export type ProfileCloudWatchTelemetry = CloudWatchTarget & { readonly region?: string };

type CloudWatchTarget = {
  /** The `<name>` of its `[telemetry.<name>]` table. */
  readonly name: string;
  /** The signal groups of its `include`; absent means the default of Box. */
  readonly include?: readonly string[];
} & (
  | {
      /** Log records, to CloudWatch Logs' OTLP endpoint. */
      readonly kind: "cloudwatch_logs";
      readonly logGroup: string;
      readonly logStream: string;
    }
  | {
      /** Spans, to X-Ray's OTLP endpoint. */
      readonly kind: "cloudwatch_traces";
    }
);

/** The longest log group or log stream name CloudWatch Logs accepts, as Box checks it. */
const MAXIMUM_LOG_NAME = 512;

/** An AWS region, as Box checks it: lower-case letters, digits, and `-`. */
const REGION = /^[a-z0-9-]{1,32}$/;

/** A log group name, as Box checks it: letters, digits, `.`, `_`, `-`, `/`, and `#`. */
const LOG_GROUP = /^[A-Za-z0-9._\-/#]+$/;

/** A log stream name, as Box checks it: no `:`, `*`, or control character. */
// oxlint-disable-next-line no-control-regex -- the control characters are what the check refuses
const NOT_IN_LOG_STREAM = /[:*\u0000-\u001f\u007f-\u009f]/;

/** The words Box takes in `include`. */
const SIGNAL_GROUPS: ReadonlySet<string> = new Set(["deny", "permit", "trace", "logs", "metrics"]);

/**
 * The `include` of a table, as Box takes it: absent, or one or more different signal groups.
 * `null` when Box refuses it.
 */
function includeOf(value: unknown): readonly string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return null;
  const known = value.every((word) => typeof word === "string" && SIGNAL_GROUPS.has(word));
  return known && new Set(value).size === value.length ? (value as string[]) : null;
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The trimmed string `value`, or undefined when it is not a string. */
const text = (value: unknown) => (typeof value === "string" ? value.trim() : undefined);

/**
 * The CloudWatch targets of the `[telemetry]` tables of `boxToml`, in profile order. A target with
 * no `region` has none here. A target that Box would refuse (a malformed region, a group or stream
 * name CloudWatch does not take, or an `include` that Box does not take) is left out, as Box stops
 * the run that declares it.
 */
export function cloudWatchTelemetry(
  boxToml: Readonly<Record<string, unknown>>,
): ProfileCloudWatchTelemetry[] {
  const tables = isTable(boxToml.telemetry) ? Object.entries(boxToml.telemetry) : [];
  const targets: ProfileCloudWatchTelemetry[] = [];
  for (const [name, entry] of tables) {
    if (!isTable(entry)) continue;
    // Box's JSON has no `region` key for a target that names none.
    const region = text(entry.region);
    const hasRegion = entry.region !== undefined;
    if (hasRegion && (region === undefined || !REGION.test(region))) continue;
    const include = includeOf(entry.include);
    if (include === null) continue;
    const common = { name, ...(include && { include }), ...(hasRegion && { region }) };
    if (entry.kind === "cloudwatch_traces") {
      targets.push({ ...common, kind: "cloudwatch_traces" });
      continue;
    }
    if (entry.kind !== "cloudwatch_logs") continue;
    const logGroup = text(entry.log_group);
    const logStream = text(entry.log_stream);
    const named = (value: string | undefined): value is string =>
      value !== undefined && value.length > 0 && value.length <= MAXIMUM_LOG_NAME;
    if (!named(logGroup) || !LOG_GROUP.test(logGroup)) continue;
    if (!named(logStream) || NOT_IN_LOG_STREAM.test(logStream)) continue;
    targets.push({ ...common, kind: "cloudwatch_logs", logGroup, logStream });
  }
  return targets;
}

/**
 * `telemetry` with `region` on each target that names none, and a warning that names those
 * targets: `agentcore dev` runs the box profile `profilePath` as it is, and Box refuses such a
 * target there.
 */
export function withDeployRegion(
  telemetry: readonly ProfileCloudWatchTelemetry[],
  region: string,
  profilePath: string,
): { telemetry: CloudWatchTelemetry[]; warnings: string[] } {
  const tables = telemetry
    .filter((target) => target.region === undefined)
    .map(({ name }) => `[telemetry.${name}]`);
  const warnings =
    tables.length === 0
      ? []
      : [
          `${profilePath}: ${tables.join(" and ")} ${tables.length > 1 ? "have" : "has"} no ` +
            `region, so the AgentCore Runtime profile and the telemetry policy get ${region}. ` +
            "Deploy sets the region of its deploy target. Box refuses a CloudWatch target with no " +
            "region, so `agentcore dev` cannot run this profile until you add region to it.",
        ];
  return {
    telemetry: telemetry.map((target) => ({ ...target, region: target.region ?? region })),
    warnings,
  };
}
