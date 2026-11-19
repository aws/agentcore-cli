/**
 * Rule 3 of the derivation: what only AgentCore Runtime needs, and the Runtime value of each
 * setting that works only under `agentcore dev`. Each other key stays as the local profile has it.
 *
 * | Key | Runtime profile |
 * | --- | --- |
 * | `packs` | the user's packs in their order, then box/agentcore, and box/agentcore-codezip for CodeZip |
 * | `[profile] name` | the project's name |
 * | `[options] bedrock.region` | the build region, where the profile sets it or imports box/bedrock |
 * | `[agent] command` | the template's own command becomes its Runtime command; a command of the user loses `--reload` and `--reload-dir <dir>` |
 * | `[agent.env]` | a template value becomes its Runtime value; `LOCAL_DEV` goes; the region, the AWS stand-ins, and (CodeZip) the ffi `PYTHONPATH` come in; a value of the user stays |
 * | `[agent.filesystem]` | the template's grants become its Runtime grants; each grant of the user stays |
 * | `[[agent.ingress]]` | each listen address is `0.0.0.0`, on its own port |
 * | `[telemetry.<name>]` | each CloudWatch target is signed with a bare `aws://`, in the deploy region when it names none |
 * | `[telemetry.agentcore]` | added when no target is `cloudwatch_logs`: the runtime's own log group and log stream |
 *
 * It moves no path: the paths rule runs after it and moves each path of the user.
 */
import {
  AGENTCORE_CODEZIP_PACK_NAME,
  AGENTCORE_PACK_NAME,
  BOX_CODEZIP_DIST,
} from "../../templates/boxProfile";
import {
  RUNTIME_INPUTS,
  type RuleResult,
  type RuntimeProfileContext,
  type TomlTable,
} from "../types";

/** The credential that signs an AWS call on AgentCore Runtime: the execution role. */
export const RUNTIME_AWS_SIGNER = "aws://";

/** The pack that sets `AWS_REGION` itself, from its `bedrock.region` input. */
const BEDROCK_PACK = "box/bedrock";

/** The variable that tells the template's agent that it runs under `agentcore dev`. */
const LOCAL_DEV = "LOCAL_DEV";

/** The `kind` of each CloudWatch target. */
const CLOUDWATCH_KINDS: ReadonlySet<unknown> = new Set(["cloudwatch_logs", "cloudwatch_traces"]);

/**
 * Stand-in AWS keys for boto3 in the box on AgentCore Runtime. They authenticate nothing: each AWS
 * route goes to the Box gateway, and box signs each call for it with the execution role.
 */
export const RUNTIME_AWS_STAND_INS: Readonly<Record<string, string>> = {
  AWS_ACCESS_KEY_ID: "box-stand-in",
  AWS_SECRET_ACCESS_KEY: "box-stand-in",
};

/** The variables that this rule sets for the Runtime itself, whatever the template's Runtime form. */
const RUNTIME_ENV_NAMES: ReadonlySet<string> = new Set([
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  ...Object.keys(RUNTIME_AWS_STAND_INS),
]);

/** The variable in which AgentCore Runtime names the runtime's own log group and log stream. */
const RUNTIME_LOGS_HEADERS_ENV = "OTEL_EXPORTER_OTLP_LOGS_HEADERS";

/**
 * The CloudWatch Logs target of a Runtime profile that has no `cloudwatch_logs` target: the
 * runtime's own log group and log stream, in its own region. The runtime ID exists only after
 * deploy, so box reads the three values through inputs of box/agentcore when the run starts.
 */
export const DEFAULT_TELEMETRY_TARGET = {
  kind: "cloudwatch_logs",
  region: RUNTIME_INPUTS.awsRegion,
  log_group: "${{ inputs.runtime.log_group }}",
  log_stream: "${{ inputs.runtime.log_stream }}",
  include: ["deny", "permit", "trace"],
  secret: { ref: RUNTIME_AWS_SIGNER },
} as const;

/**
 * The Runtime's region in the agent's environment, from the box/agentcore `aws.region` input.
 * box/bedrock sets `AWS_REGION` itself, so the profile sets it only without that pack.
 */
export function runtimeRegionEnv(bedrock: boolean): Record<string, string> {
  const region = RUNTIME_INPUTS.awsRegion;
  return { ...(!bedrock && { AWS_REGION: region }), AWS_DEFAULT_REGION: region };
}

/** The comment lines above `profile`, the Runtime profile of `context.runtime`. */
export function runtimeProfileHeader(
  context: RuntimeProfileContext,
  profile: Readonly<TomlTable> = {},
): string[] {
  const packs =
    context.paths.build === "CodeZip"
      ? `The ${AGENTCORE_PACK_NAME} and ${AGENTCORE_CODEZIP_PACK_NAME} packs carry the deployed ` +
        "resources, the Runtime Python, and the code directory."
      : `The ${AGENTCORE_PACK_NAME} pack carries the deployed resources' variables.`;
  return [
    `Runs the agent of the AgentCore project '${context.spec.name}' in a box.`,
    `Derived by agentcore build and deploy from ${context.profileFile}, for AgentCore Runtime. ${packs}`,
    `${Object.keys(RUNTIME_AWS_STAND_INS).join(" and ")} are stand-ins so boto3 in the box can ` +
      "build its requests. They authenticate nothing: every AWS route goes to the Box gateway, " +
      "and box signs each request for it with the execution role.",
    ...Object.entries(tableOf(profile.telemetry))
      .filter(([, target]) => sameValue(target, DEFAULT_TELEMETRY_TARGET))
      .map(
        ([name]) =>
          `[telemetry.${name}] is the default CloudWatch Logs target: the runtime's own log group ` +
          `and log stream, which box reads from ${RUNTIME_LOGS_HEADERS_ENV} when the run starts. ` +
          `Add a cloudwatch_logs target to ${context.profileFile} to use another.`,
      ),
  ];
}

export function apply(table: Readonly<TomlTable>, context: RuntimeProfileContext): RuleResult {
  const result = structuredClone(table) as TomlTable;
  const packs = runtimePacks(result.packs, context);
  result.packs = packs;
  result.profile = { ...(isTable(result.profile) ? result.profile : {}), name: context.spec.name };
  const bedrock = Array.isArray(packs) && packs.includes(BEDROCK_PACK);
  const options = runtimeOptions(result.options, bedrock, context.region);
  if (options !== undefined) result.options = options;
  result.agent = runtimeAgent(result.agent, bedrock, context);
  result.telemetry = runtimeTelemetry(result.telemetry, context);
  return { table: result, problems: [], warnings: [] };
}

/** The user's packs in their order, then each Runtime pack that they do not import. */
function runtimePacks(packs: unknown, context: RuntimeProfileContext): unknown {
  // box refuses `packs` that is not a list before build gets the profile.
  if (packs !== undefined && !Array.isArray(packs)) return packs;
  const runtime = [
    AGENTCORE_PACK_NAME,
    ...(context.paths.build === "CodeZip" ? [AGENTCORE_CODEZIP_PACK_NAME] : []),
  ];
  const own = (packs ?? []) as unknown[];
  return [...own, ...runtime.filter((pack) => !own.includes(pack))];
}

/**
 * `[options]` with `bedrock.region` in the build region, the region of the gateway's `bedrock`
 * target: where the profile sets it, as a dotted or a quoted key, or where it imports box/bedrock.
 */
function runtimeOptions(options: unknown, bedrock: boolean, region: string): unknown {
  if (options !== undefined && !isTable(options)) return options;
  const quoted = options !== undefined && Object.hasOwn(options, "bedrock.region");
  const dotted = options !== undefined && isTable(options.bedrock);
  if (!quoted && !dotted && !bedrock) return options;
  const result: TomlTable = { ...options };
  if (quoted) result["bedrock.region"] = region;
  if (dotted || !quoted) result.bedrock = { ...(result.bedrock as TomlTable), region };
  return result;
}

/** `[agent]` with its command, env, filesystem, and ingress for the Runtime; other keys stay. */
function runtimeAgent(agent: unknown, bedrock: boolean, context: RuntimeProfileContext): unknown {
  if (agent !== undefined && !isTable(agent)) return agent;
  const local: TomlTable = agent ?? {};
  const templateLocal = tableOf(context.template.local.agent);
  const templateRuntime = tableOf(context.template.runtime.agent);
  const result: TomlTable = { ...local };
  if (local.command !== undefined) {
    result.command = sameValue(local.command, templateLocal.command)
      ? structuredClone(templateRuntime.command)
      : withoutReload(local.command);
  }
  result.env = runtimeEnv(
    local.env,
    tableOf(templateLocal.env),
    tableOf(templateRuntime.env),
    bedrock,
    context,
  );
  const filesystem = runtimeFilesystem(
    local.filesystem,
    tableOf(templateLocal.filesystem),
    tableOf(templateRuntime.filesystem),
  );
  if (filesystem !== undefined) result.filesystem = filesystem;
  if (local.ingress !== undefined) {
    result.ingress = runtimeIngress(local.ingress, templateLocal.ingress, templateRuntime.ingress);
  }
  return result;
}

/** A command with no `--reload`, `--reload-dir <dir>`, or `--reload-dir=<dir>`. */
function withoutReload(command: unknown): unknown {
  if (!Array.isArray(command)) return command;
  const result: unknown[] = [];
  for (let index = 0; index < command.length; index++) {
    const word: unknown = command[index];
    if (word === "--reload") continue;
    if (word === "--reload-dir") {
      index++;
      continue;
    }
    if (typeof word === "string" && word.startsWith("--reload-dir=")) continue;
    result.push(word);
  }
  return result;
}

/**
 * `[agent.env]` for the Runtime. A variable of the template that the local profile keeps with the
 * template's value gets its Runtime value, or goes when the Runtime has none. A variable that only
 * the Runtime has comes in, unless the user sets it. A variable of the user stays. `LOCAL_DEV`
 * goes, whatever its value. This rule sets the region and the AWS stand-ins itself. On CodeZip,
 * `PYTHONPATH` starts with the ffi shim.
 */
function runtimeEnv(
  env: unknown,
  templateLocal: TomlTable,
  templateRuntime: TomlTable,
  bedrock: boolean,
  context: RuntimeProfileContext,
): unknown {
  if (env !== undefined && !isTable(env)) return env;
  const local: TomlTable = env ?? {};
  const has = (name: string) => Object.hasOwn(local, name);
  const ofTemplate = (name: string) =>
    Object.hasOwn(templateLocal, name) && sameValue(local[name], templateLocal[name]);
  const added: TomlTable = { ...runtimeRegionEnv(bedrock), ...RUNTIME_AWS_STAND_INS };
  const result: TomlTable = {};
  for (const [name, value] of Object.entries(templateRuntime)) {
    if (RUNTIME_ENV_NAMES.has(name)) continue;
    if (!Object.hasOwn(templateLocal, name)) result[name] = has(name) ? local[name] : value;
    else if (has(name)) result[name] = ofTemplate(name) ? value : local[name];
  }
  for (const [name, value] of Object.entries(added)) {
    result[name] = has(name) ? local[name] : value;
  }
  for (const [name, value] of Object.entries(local)) {
    if (name === LOCAL_DEV || Object.hasOwn(result, name) || ofTemplate(name)) continue;
    result[name] = value;
  }
  if (context.paths.build === "CodeZip") {
    // The ffi shim that deploy stages: its libffi uses static trampolines, which W^X allows.
    const code = context.paths.runtimeCode;
    const shim = `${code}/${BOX_CODEZIP_DIST}/ffi`;
    const path = result.PYTHONPATH;
    if (path === undefined) result.PYTHONPATH = `${shim}:${code}`;
    else if (typeof path === "string" && path.split(":")[0] !== shim) {
      result.PYTHONPATH = `${shim}:${path}`;
    }
  }
  return result;
}

/**
 * `[agent.filesystem]` for the Runtime. In each list, the template's Runtime grants come first:
 * each one that only the Runtime has, and each one that the template has under dev too and the
 * local profile keeps. Each grant of the user follows in its order. A list that ends empty goes.
 */
function runtimeFilesystem(
  filesystem: unknown,
  templateLocal: TomlTable,
  templateRuntime: TomlTable,
): unknown {
  if (filesystem !== undefined && !isTable(filesystem)) return filesystem;
  const local: TomlTable = filesystem ?? {};
  const result: TomlTable = {};
  const names = [...new Set([...Object.keys(local), ...Object.keys(templateRuntime)])];
  for (const name of names) {
    const own = local[name];
    if (own !== undefined && !Array.isArray(own)) {
      result[name] = own;
      continue;
    }
    const grants = (own ?? []) as unknown[];
    const localGrants = listOf(templateLocal[name]);
    const kept = listOf(templateRuntime[name]).filter(
      (grant) => !includes(localGrants, grant) || includes(grants, grant),
    );
    const users = grants.filter(
      (grant, index) =>
        !includes(localGrants, grant) &&
        !includes(kept, grant) &&
        !includes(grants.slice(0, index), grant),
    );
    const list = [...structuredClone(kept), ...users];
    if (list.length > 0) result[name] = list;
  }
  return filesystem !== undefined || Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Each `[[agent.ingress]]` for the Runtime: the template's own ingress becomes its Runtime ingress,
 * and each other one listens on `0.0.0.0` on its own port, as the Runtime reaches the microVM there.
 */
function runtimeIngress(
  ingress: unknown,
  templateLocal: unknown,
  templateRuntime: unknown,
): unknown {
  if (isTable(ingress)) return onAllAddresses(ingress);
  if (!Array.isArray(ingress)) return ingress;
  const localEntries = listOf(templateLocal);
  const runtimeEntries = listOf(templateRuntime);
  return ingress.map((entry: unknown) => {
    const index = localEntries.findIndex((other) => sameValue(other, entry));
    const runtime = index >= 0 ? runtimeEntries[index] : undefined;
    return runtime !== undefined ? structuredClone(runtime) : onAllAddresses(entry);
  });
}

/** An ingress whose `listen` is `0.0.0.0:<its port>`. */
function onAllAddresses(entry: unknown): unknown {
  if (!isTable(entry) || typeof entry.listen !== "string") return entry;
  const port = /:(\d+)$/.exec(entry.listen)?.[1];
  return port === undefined ? entry : { ...entry, listen: `0.0.0.0:${port}` };
}

/**
 * `[telemetry]` for the Runtime: each CloudWatch target of the local profile with its keys, signed
 * with a bare `aws://`, in the deploy region when it names none; then each CloudWatch target of the
 * context that the local profile does not declare, as box resolves it. A target of another kind
 * stays as it is. With no `cloudwatch_logs` target, {@link DEFAULT_TELEMETRY_TARGET} comes last, as
 * `agentcore`, or as `agentcore_default` when a target has that name.
 */
function runtimeTelemetry(telemetry: unknown, context: RuntimeProfileContext): unknown {
  if (telemetry !== undefined && !isTable(telemetry)) return telemetry;
  const local: TomlTable = telemetry ?? {};
  const resolved = new Map(context.telemetry.map((target) => [target.name, target]));
  const result: TomlTable = {};
  for (const [name, entry] of Object.entries(local)) {
    if (!isTable(entry) || !CLOUDWATCH_KINDS.has(entry.kind)) {
      result[name] = entry;
      continue;
    }
    const { kind, region, ...rest } = entry;
    result[name] = {
      kind,
      region: region ?? resolved.get(name)?.region ?? context.region,
      ...rest,
      secret: { ref: RUNTIME_AWS_SIGNER },
    };
  }
  for (const target of context.telemetry) {
    if (Object.hasOwn(local, target.name)) continue;
    result[target.name] = {
      kind: target.kind,
      region: target.region,
      ...(target.kind === "cloudwatch_logs" && {
        log_group: target.logGroup,
        log_stream: target.logStream,
      }),
      ...(target.include && { include: [...target.include] }),
      secret: { ref: RUNTIME_AWS_SIGNER },
    };
  }
  const logs = Object.values(result).some(
    (entry) => isTable(entry) && entry.kind === "cloudwatch_logs",
  );
  if (!logs) {
    const name = Object.hasOwn(result, "agentcore") ? "agentcore_default" : "agentcore";
    result[name] = structuredClone(DEFAULT_TELEMETRY_TARGET);
  }
  return result;
}

const isTable = (value: unknown): value is TomlTable =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** `value` when it is a table, or an empty table. */
const tableOf = (value: unknown): TomlTable => (isTable(value) ? value : {});

/** `value` when it is a list, or an empty list. */
const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** Whether `list` holds a value equal to `value`. */
const includes = (list: readonly unknown[], value: unknown) =>
  list.some((other) => sameValue(other, value));

/** Whether two TOML values are equal: tables by their keys in any order, lists in order. */
function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (isTable(left) || isTable(right)) {
    if (!isTable(left) || !isTable(right)) return false;
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
    );
  }
  return Object.is(left, right);
}
