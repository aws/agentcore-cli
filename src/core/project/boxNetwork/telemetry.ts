/**
 * Reads the CloudWatch targets of a box profile from the `[telemetry.<name>]` tables of the
 * `box.toml` that Box resolves it to. On AgentCore Runtime, Box signs each CloudWatch target with
 * the execution role, so build grants that role what these targets send, and copies each target
 * into the AgentCore Runtime profile. It also reads the targets that send to a third party, whose
 * key build moves to AWS Secrets Manager for the Runtime.
 */

/** A CloudWatch target of the box profile, as Box sends to it. */
export type CloudWatchTelemetry = {
  /** The `<name>` of its `[telemetry.<name>]` table. */
  readonly name: string;
  /** The signal groups of its `include`; absent means the default of Box. */
  readonly include?: readonly string[];
} & (
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
 * The CloudWatch targets of the `[telemetry]` tables of `boxToml`, in profile order. A target that
 * Box would refuse (no region, a group or stream name CloudWatch does not take, or an `include`
 * that Box does not take) is left out, so it gets no grant and no copy in the AgentCore Runtime
 * profile: Box stops the run that declares it.
 */
export function cloudWatchTelemetry(
  boxToml: Readonly<Record<string, unknown>>,
): CloudWatchTelemetry[] {
  const tables = isTable(boxToml.telemetry) ? Object.entries(boxToml.telemetry) : [];
  const targets: CloudWatchTelemetry[] = [];
  for (const [name, entry] of tables) {
    if (!isTable(entry)) continue;
    const region = text(entry.region);
    if (region === undefined || !REGION.test(region)) continue;
    const include = includeOf(entry.include);
    if (include === null) continue;
    const common = { name, ...(include && { include }), region };
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

/** The kinds of target that send to a third party's OTLP endpoint, and not to AWS. */
const THIRD_PARTY_KINDS = ["otlp", "langfuse", "langsmith"] as const;

/** A value of a telemetry table that build copies: a string, a string array, or a string table. */
export type TelemetryValue = string | readonly string[] | Readonly<Record<string, string>>;

/**
 * A target of the box profile that sends to a third party: its `[telemetry.<name>]` table as Box
 * resolves it. On AgentCore Runtime the variable that holds its key does not exist, so Box reads
 * the key from AWS Secrets Manager instead (see `boxTelemetrySecretName`).
 */
export interface ThirdPartyTelemetry {
  /** The `<name>` of its `[telemetry.<name>]` table. */
  readonly name: string;
  readonly kind: (typeof THIRD_PARTY_KINDS)[number];
  /** The keys of its table besides `kind` and `secret`, in {@link COPIED_KEYS} order. */
  readonly keys: readonly (readonly [string, TelemetryValue])[];
  /** Its `secret`: the variable Box reads the key from, and the other keys of the table. */
  readonly secret?: {
    readonly variable: string;
    readonly keys: readonly (readonly [string, string])[];
  };
}

/** A third-party target that the AgentCore Runtime profile leaves out, and why. */
export interface LeftOutTelemetry {
  readonly name: string;
  readonly reason: string;
}

/** The keys of a third-party table that Box takes, besides `kind` and `secret`. */
const COPIED_KEYS = ["destination", "project", "include", "accepts", "headers"] as const;

/** The keys of a `secret` table that Box takes, besides `ref`. */
const COPIED_SECRET_KEYS = ["header", "prefix", "placement"] as const;

/** The schemes that name a variable of the environment of `box run`. */
const VARIABLE_SCHEMES = ["env://", "secret://"] as const;

/** A variable name that a deploy can also read: letters, digits, and `_`. */
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A target name that can name the variable deploy reads its key from: letters, digits, `_`, and
 * `-`, as a credential name.
 */
const SECRET_TARGET_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/** A string, a string array, or a table of strings, or `undefined` for any other value. */
function copiedValue(value: unknown): TelemetryValue | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
  }
  if (!isTable(value)) return undefined;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === "string")
    ? (value as Record<string, string>)
    : undefined;
}

/**
 * The third-party targets (`otlp`, `langfuse`, `langsmith`) of the `[telemetry]` tables of
 * `boxToml`, in profile order, and the ones the AgentCore Runtime profile cannot carry. A target
 * carries an `env://` or `secret://` key, or no key. A target with a key in any other scheme is
 * left out, because the Runtime has no such source. So is a target with a key whose name cannot
 * name a variable.
 * A `file` target and a CloudWatch target are neither.
 */
export function thirdPartyTelemetry(boxToml: Readonly<Record<string, unknown>>): {
  readonly targets: readonly ThirdPartyTelemetry[];
  readonly leftOut: readonly LeftOutTelemetry[];
} {
  const tables = isTable(boxToml.telemetry) ? Object.entries(boxToml.telemetry) : [];
  const targets: ThirdPartyTelemetry[] = [];
  const leftOut: LeftOutTelemetry[] = [];
  for (const [name, entry] of tables) {
    if (!isTable(entry)) continue;
    const kind = THIRD_PARTY_KINDS.find((candidate) => candidate === entry.kind);
    if (kind === undefined) continue;
    const keys: (readonly [string, TelemetryValue])[] = [];
    const uncopied = COPIED_KEYS.filter((key) => {
      if (entry[key] === undefined) return false;
      const value = copiedValue(entry[key]);
      if (value !== undefined) keys.push([key, value]);
      return value === undefined;
    });
    if (uncopied.length > 0) {
      leftOut.push({
        name,
        reason: `Box resolves its \`${uncopied[0]}\` to a value build cannot copy`,
      });
      continue;
    }
    if (entry.secret === undefined) {
      targets.push({ name, kind, keys });
      continue;
    }
    const secret = isTable(entry.secret) ? entry.secret : {};
    const reference = text(secret.ref) ?? "";
    const scheme = VARIABLE_SCHEMES.find((candidate) => reference.startsWith(candidate));
    const variable = scheme === undefined ? undefined : reference.slice(scheme.length);
    if (variable === undefined || !VARIABLE.test(variable)) {
      leftOut.push({
        name,
        reason:
          "its `secret.ref` names no `env://` or `secret://` variable, and build moves only such a " +
          "key to AWS Secrets Manager",
      });
      continue;
    }
    if (!SECRET_TARGET_NAME.test(name)) {
      leftOut.push({
        name,
        reason:
          "its name cannot name the variable deploy reads its key from. Use only letters, " +
          "digits, `_`, and `-`, at most 128 characters",
      });
      continue;
    }
    const secretKeys = COPIED_SECRET_KEYS.flatMap((key) =>
      typeof secret[key] === "string" ? [[key, secret[key]] as const] : [],
    );
    targets.push({ name, kind, keys, secret: { variable, keys: secretKeys } });
  }
  return { targets, leftOut };
}
