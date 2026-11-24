/**
 * Rule 3 of the derivation: what only AgentCore Runtime needs, and the Runtime value of each
 * setting that works only under `agentcore dev`. Each other key stays as the local profile has it.
 *
 * | Key | Runtime profile |
 * | --- | --- |
 * | `packs` | the user's packs in their order, then @box/agentcore, and @box/agentcore-codezip for CodeZip |
 * | `[profile] name` | the project's name |
 * | `[options] bedrock.region` | the build region, where the profile sets it or imports @box/bedrock |
 * | `[options] bedrock.sign-in` | `api-key`, beside `bedrock.region`: the gateway signs each Bedrock call, and box refuses the `aws://` route of @box/bedrock beside its backend |
 * | `[agent] command` | the template's own command becomes its Runtime command; a command of the user loses `--reload` and `--reload-dir <dir>`; with OTEL on, a command of the venv's Python starts under opentelemetry-instrument |
 * | `[agent.env]` | a template value becomes its Runtime value; `LOCAL_DEV` goes; the region of the Runtime replaces a region of the user, with a warning; `AWS_PROFILE` goes, with a warning; the AWS stand-ins and (CodeZip) a `PYTHONPATH` of the code folder come in; each other value of the user stays |
 * | `[agent.filesystem]` | the template's grants become its Runtime grants; each grant of the user stays |
 * | `[[agent.ingress]]` | the first listens on `0.0.0.0` on the port of the protocol, and forwards to the workload port of the template when the agent keeps its command and port, with a warning for each port that changes; each other listens on `0.0.0.0` on its own port |
 * | `[tool.<name>]` | a table that the template writes, as it writes it, goes; a table of the user stays |
 * | `[telemetry.<name>]` | each CloudWatch target that box takes is signed with a bare `aws://`, in the deploy region when it names none; one that box refuses goes; a `file` target goes, with a warning |
 * | `[telemetry.agentcore]` | added when no target is `cloudwatch_logs`: the runtime's own log group and log stream |
 * | `[telemetry.agentcore_traces]` | added with OTEL on when no target is `cloudwatch_traces`: X-Ray in the Runtime's region |
 *
 * It moves no path: the paths rule runs after it and moves each path of the user.
 */
import { posix } from "node:path";
import {
  AGENTCORE_CODEZIP_PACK_NAME,
  AGENTCORE_PACK_NAME,
  BOX_BEDROCK_PACK,
  BOX_BEDROCK_RUNTIME_SIGN_IN,
  boxIngressPort,
  boxWorkloadPort,
  OBSERVABILITY_OFF_ENV,
  observabilityOff,
  otelOn,
  RUNTIME_LOGS_HEADERS_ENV,
} from "../../templates/boxProfile";
import type { CloudWatchTelemetry } from "../../boxNetwork";
import { isTable, isVenvPython } from "../projectPaths";
import { FILE_TELEMETRY_KIND } from "./refusals";
import {
  RUNTIME_AWS_SIGNER,
  RUNTIME_INPUTS,
  type RuleResult,
  type RuntimePaths,
  type RuntimeProfileContext,
  type TomlTable,
} from "../types";

/** The variables of the region of the agent, which get the region of the Runtime. */
const REGION_ENV_NAMES: ReadonlySet<string> = new Set(["AWS_REGION", "AWS_DEFAULT_REGION"]);

/** The variable of a named AWS profile, which AgentCore Runtime does not have. */
const AWS_PROFILE = "AWS_PROFILE";

/** The variable that tells the template's agent that it runs under `agentcore dev`. */
const LOCAL_DEV = "LOCAL_DEV";

/** The `kind` of each CloudWatch target. */
const CLOUDWATCH_KINDS: ReadonlySet<unknown> = new Set(["cloudwatch_logs", "cloudwatch_traces"]);

/**
 * Stand-in AWS keys for boto3 in the box on AgentCore Runtime. They authenticate nothing: each AWS
 * route goes to the Box gateway, and box signs each call for it with the execution role.
 */
const RUNTIME_AWS_STAND_INS: Readonly<Record<string, string>> = {
  AWS_ACCESS_KEY_ID: "box-stand-in",
  AWS_SECRET_ACCESS_KEY: "box-stand-in",
};

/** The variables that this rule sets for the Runtime itself, whatever the template's Runtime form. */
const RUNTIME_ENV_NAMES: ReadonlySet<string> = new Set([
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  ...Object.keys(RUNTIME_AWS_STAND_INS),
]);

/**
 * The CloudWatch Logs target of a Runtime profile that has no `cloudwatch_logs` target: the
 * runtime's own log group and log stream, in its own region. The runtime ID exists only after
 * deploy, so box reads the three values through inputs of @box/agentcore when the run starts.
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
 * The X-Ray target of a Runtime profile with OTEL on ({@link otelOn}) that has no
 * `cloudwatch_traces` target: the agent's spans and box's own, in the Runtime's region, signed with
 * the execution role.
 */
export const DEFAULT_TRACES_TARGET = {
  kind: "cloudwatch_traces",
  region: RUNTIME_INPUTS.awsRegion,
  include: ["deny", "permit", "trace"],
  secret: { ref: RUNTIME_AWS_SIGNER },
} as const;

/** The program that starts a Python command with the OpenTelemetry instrumentation. */
const OTEL_INSTRUMENT = "opentelemetry-instrument";

/** Whether `command` starts under opentelemetry-instrument, as its program or as the script of it. */
function startsUnderOtel(command: unknown): boolean {
  return (
    Array.isArray(command) &&
    command
      .slice(0, 2)
      .some((word) => typeof word === "string" && posix.basename(word) === OTEL_INSTRUMENT)
  );
}

/**
 * The Runtime's region in the agent's environment, from the @box/agentcore `aws.region` input.
 * @box/bedrock sets `AWS_REGION` itself, so the profile sets it only without that pack.
 */
function runtimeRegionEnv(bedrock: boolean): Record<string, string> {
  const region = RUNTIME_INPUTS.awsRegion;
  return { ...(!bedrock && { AWS_REGION: region }), AWS_DEFAULT_REGION: region };
}

/**
 * The notice that `agentcore create` and `agentcore add runtime` give for a box runtime: what the
 * default log target sends, where, what it costs, and how to turn it off.
 */
export function defaultLogTargetNotice(runtimeName: string, profileFile: string): string {
  return (
    `runtime "${runtimeName}": when ${profileFile} has no cloudwatch_logs target, box on ` +
    "AgentCore Runtime sends its deny, permit, and trace records to the log group of the " +
    "runtime, /aws/bedrock-agentcore/runtimes/<runtime ID>-DEFAULT, log stream otel-rt-logs. The " +
    "Runtime makes that log group, so its retention applies, and the log group stays after the " +
    "runtime is removed. CloudWatch Logs charges for the records. To send none, set " +
    `${OBSERVABILITY_OFF_ENV} to "true" in the envVars of the runtime in agentcore.json.`
  );
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
    ...defaultTracesTargets(profile).map(
      (name) =>
        `[telemetry.${name}] is the default X-Ray target: the agent's spans and box's own, in the ` +
        `Runtime's region. Add a cloudwatch_traces target to ${context.profileFile} to use ` +
        "another, or set instrumentation.enableOtel to false in agentcore.json to send none.",
    ),
  ];
}

/** The name of each {@link DEFAULT_TRACES_TARGET} in the `[telemetry]` of `profile`. */
function defaultTracesTargets(profile: Readonly<TomlTable>): string[] {
  return Object.entries(tableOf(profile.telemetry))
    .filter(([, target]) => sameValue(target, DEFAULT_TRACES_TARGET))
    .map(([name]) => name);
}

/**
 * Each {@link DEFAULT_TRACES_TARGET} of `profile`, a Runtime profile, as a CloudWatch target in
 * `region`, the region build builds for: the execution role needs a grant for it.
 */
export function defaultTracesTelemetry(
  profile: Readonly<TomlTable>,
  region: string,
): CloudWatchTelemetry[] {
  return defaultTracesTargets(profile).map((name) => ({
    name,
    kind: "cloudwatch_traces",
    region,
    include: [...DEFAULT_TRACES_TARGET.include],
  }));
}

/** Whether the `[agent] command` of `profile`, a Runtime profile, starts under opentelemetry-instrument. */
export function agentStartsUnderOtel(profile: Readonly<TomlTable>): boolean {
  return startsUnderOtel(tableOf(profile.agent).command);
}

export function apply(table: Readonly<TomlTable>, context: RuntimeProfileContext): RuleResult {
  const result = structuredClone(table) as TomlTable;
  const packs = runtimePacks(result.packs, context);
  result.packs = packs;
  result.profile = { ...(isTable(result.profile) ? result.profile : {}), name: context.spec.name };
  // The pack that sets `AWS_REGION` itself, from its `bedrock.region` input.
  const bedrock = Array.isArray(packs) && packs.includes(BOX_BEDROCK_PACK);
  const options = runtimeOptions(result.options, bedrock, context.region);
  if (options !== undefined) result.options = options;
  const warnings: string[] = [];
  result.agent = runtimeAgent(result.agent, bedrock, context, warnings);
  if (result.tool !== undefined) {
    const tool = runtimeTools(result.tool, context);
    if (tool === undefined) delete result.tool;
    else result.tool = tool;
  }
  result.telemetry = runtimeTelemetry(result.telemetry, context, warnings);
  return { table: result, problems: [], warnings };
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
 * target, and `bedrock.sign-in` of the route that goes through the gateway: where the profile sets
 * `bedrock.region`, as a dotted or a quoted key, or where it imports @box/bedrock.
 */
function runtimeOptions(options: unknown, bedrock: boolean, region: string): unknown {
  if (options !== undefined && !isTable(options)) return options;
  const quoted = options !== undefined && Object.hasOwn(options, "bedrock.region");
  const dotted = options !== undefined && isTable(options.bedrock);
  if (!quoted && !dotted && !bedrock) return options;
  const result: TomlTable = { ...options };
  const signIn = BOX_BEDROCK_RUNTIME_SIGN_IN;
  if (quoted) {
    result["bedrock.region"] = region;
    result["bedrock.sign-in"] = signIn;
  }
  if (dotted || !quoted) {
    result.bedrock = { ...(result.bedrock as TomlTable), region, "sign-in": signIn };
  }
  return result;
}

/** `[agent]` with its command, env, filesystem, and ingress for the Runtime; other keys stay. */
function runtimeAgent(
  agent: unknown,
  bedrock: boolean,
  context: RuntimeProfileContext,
  warnings: string[],
): unknown {
  if (agent !== undefined && !isTable(agent)) return agent;
  const local: TomlTable = agent ?? {};
  const templateLocal = tableOf(context.template.local.agent);
  const templateRuntime = tableOf(context.template.runtime.agent);
  const result: TomlTable = { ...local };
  if (local.command !== undefined) {
    const command = sameValue(local.command, templateLocal.command)
      ? structuredClone(templateRuntime.command)
      : withoutReload(local.command);
    result.command = otelOn(context.runtime) ? underOtel(command, context.paths) : command;
  }
  result.env = runtimeEnv(
    local.env,
    tableOf(templateLocal.env),
    tableOf(templateRuntime.env),
    bedrock,
    context,
    warnings,
  );
  const filesystem = runtimeFilesystem(
    local.filesystem,
    tableOf(templateLocal.filesystem),
    tableOf(templateRuntime.filesystem),
  );
  if (filesystem !== undefined) result.filesystem = filesystem;
  if (local.ingress !== undefined) {
    const variable = PORT_ENV[context.runtime.protocol ?? "HTTP"] ?? "PORT";
    const keepsTemplatePort =
      sameValue(local.command, templateLocal.command) &&
      sameValue(tableOf(local.env)[variable], tableOf(templateLocal.env)[variable]);
    result.ingress = runtimeIngress(local.ingress, keepsTemplatePort, context, warnings);
  }
  return result;
}

/**
 * `[tool]` for the Runtime. A `[tool.<name>]` that the local profile keeps as the template writes
 * it goes: the `deny_write` that a CodeZip template gives a tool of @box/base protects the local
 * venv, and the Runtime has no venv. Each other tool table stays. An empty `[tool]` goes.
 */
function runtimeTools(tool: unknown, context: RuntimeProfileContext): unknown {
  if (!isTable(tool)) return tool;
  const templateLocal = tableOf(context.template.local.tool);
  const result: TomlTable = {};
  for (const [name, entry] of Object.entries(tool)) {
    if (!Object.hasOwn(templateLocal, name) || !sameValue(entry, templateLocal[name])) {
      result[name] = entry;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
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
 * `command` under opentelemetry-instrument (`paths.otelInstrument`) when its program is the venv's
 * Python, whose dependencies hold the script. A command that already starts under it, or that runs
 * another program, stays.
 */
function underOtel(command: unknown, paths: RuntimePaths): unknown {
  if (!Array.isArray(command) || startsUnderOtel(command)) return command;
  const program: unknown = command[0];
  if (typeof program !== "string" || !isVenvPython(program, paths)) return command;
  return [...paths.otelInstrument, ...command];
}

/**
 * `[agent.env]` for the Runtime. A variable of the template that the local profile keeps with the
 * template's value gets its Runtime value, or goes when the Runtime has none. A variable that only
 * the Runtime has comes in, unless the user sets it. A variable of the user stays. `LOCAL_DEV`
 * goes, whatever its value. This rule sets the region and the AWS stand-ins itself. On CodeZip, an
 * agent with no `PYTHONPATH` gets the code folder, where the Runtime installs the dependencies.
 */
function runtimeEnv(
  env: unknown,
  templateLocal: TomlTable,
  templateRuntime: TomlTable,
  bedrock: boolean,
  context: RuntimeProfileContext,
  warnings: string[],
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
    // The region of the Runtime wins: the hosts that the profile routes are in that region.
    result[name] = has(name) && !REGION_ENV_NAMES.has(name) ? local[name] : value;
  }
  for (const name of REGION_ENV_NAMES) {
    if (!has(name) || sameValue(local[name], result[name])) continue;
    warnings.push(
      `[agent.env] ${name} is ${JSON.stringify(local[name])} in ${context.profileFile}. On ` +
        "AgentCore Runtime the agent gets the region of the Runtime" +
        (Object.hasOwn(result, name)
          ? `, ${RUNTIME_INPUTS.awsRegion}`
          : ` from ${BOX_BEDROCK_PACK}`) +
        ", so build does not use this value.",
    );
  }
  if (has(AWS_PROFILE)) {
    warnings.push(
      `[agent.env] ${AWS_PROFILE} is ${JSON.stringify(local[AWS_PROFILE])} in ` +
        `${context.profileFile}. AgentCore Runtime has no AWS profiles: box signs each AWS call ` +
        `with the execution role. Build does not send ${AWS_PROFILE} to the Runtime.`,
    );
  }
  for (const [name, value] of Object.entries(local)) {
    if (name === LOCAL_DEV || name === AWS_PROFILE || REGION_ENV_NAMES.has(name)) continue;
    if (Object.hasOwn(result, name) || ofTemplate(name)) continue;
    result[name] = value;
  }
  if (context.paths.build === "CodeZip" && result.PYTHONPATH === undefined) {
    result.PYTHONPATH = context.paths.runtimeCode;
  }
  return result;
}

/**
 * `[agent.filesystem]` for the Runtime. In each list, the template's Runtime grants come first,
 * and each grant of the user follows in its order. A Runtime grant of the template whose path the
 * local template list has stays only when the local list keeps it, so a grant that the user removed
 * stays removed. A Runtime grant that only the Runtime has (the loader folders, and exec on the code
 * folder, where the Runtime installs the dependencies and their native modules) always stays. A
 * grant is the same as another when its path is, whether it is optional or not. A list that ends
 * empty goes.
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
    const runtimeGrants = listOf(templateRuntime[name]);
    const kept = runtimeGrants.filter(
      (grant) => !includesPath(localGrants, grant) || includesPath(grants, grant),
    );
    const users = grants.filter(
      (grant, index) =>
        !includesPath(localGrants, grant) &&
        !includesPath(kept, grant) &&
        !includesPath(grants.slice(0, index), grant),
    );
    const list = [...structuredClone(kept), ...users];
    if (list.length > 0) result[name] = list;
  }
  return filesystem !== undefined || Object.keys(result).length > 0 ? result : undefined;
}

/** The path of a filesystem grant: the string, or the `path` of a grant table. */
const pathOf = (grant: unknown): unknown =>
  isTable(grant) && typeof grant.path === "string" ? grant.path : grant;

/** Whether `list` holds a grant of the path of `grant`, optional or not. */
const includesPath = (list: readonly unknown[], grant: unknown) =>
  list.some((other) => sameValue(pathOf(other), pathOf(grant)));

/** The variable that names the port of the agent of a template, for each protocol. */
const PORT_ENV: Readonly<Record<string, string>> = {
  HTTP: "PORT",
  AGUI: "PORT",
  A2A: "A2A_PORT",
  MCP: "FASTMCP_PORT",
};

/**
 * Each `[[agent.ingress]]` for the Runtime. AgentCore Runtime sends the requests of the protocol
 * only to its port (boxIngressPort), so the first ingress listens on `0.0.0.0:<that port>`. It
 * forwards to the workload port of the template when the agent keeps the command and the port
 * variable of the template: the Runtime form of the template starts the agent on the same port as
 * the local form. Else it forwards to its own `workload_port`, where the agent of the user listens
 * under dev too. Each other ingress listens on `0.0.0.0` on its own port. A warning names each port
 * of the local profile that changes.
 */
function runtimeIngress(
  ingress: unknown,
  agentKeepsTemplatePort: boolean,
  context: RuntimeProfileContext,
  warnings: string[],
): unknown {
  const entries = isTable(ingress) ? [ingress] : Array.isArray(ingress) ? ingress : undefined;
  if (entries === undefined) return ingress;
  const protocol = context.runtime.protocol ?? "HTTP";
  const port = boxIngressPort(protocol);
  const listen = `0.0.0.0:${port}`;
  const result = entries.map((entry: unknown, index) => {
    if (index > 0 || !isTable(entry)) return onAllAddresses(entry);
    const workload = agentKeepsTemplatePort ? boxWorkloadPort(protocol) : entry.workload_port;
    const localPort =
      typeof entry.listen === "string" ? /:(\d+)$/.exec(entry.listen)?.[1] : undefined;
    if (localPort !== undefined && Number(localPort) !== port) {
      warnings.push(
        `[[agent.ingress]] listen is ${JSON.stringify(entry.listen)} in ${context.profileFile}. ` +
          `AgentCore Runtime sends the ${protocol} requests only to port ${port}, so the Runtime ` +
          `profile listens on ${listen}.`,
      );
    }
    // A workload_port that the local profile does not set is no change of the user's.
    if (entry.workload_port !== undefined && workload !== entry.workload_port) {
      warnings.push(
        `[[agent.ingress]] workload_port is ${String(entry.workload_port)} in ` +
          `${context.profileFile}, but the agent keeps the command and the port of the template, ` +
          `so on AgentCore Runtime it listens on ${String(workload)}. The Runtime profile forwards ` +
          "there.",
      );
    }
    return { ...entry, listen, workload_port: workload };
  });
  return isTable(ingress) ? result[0] : result;
}

/** An ingress whose `listen` is `0.0.0.0:<its port>`. */
function onAllAddresses(entry: unknown): unknown {
  if (!isTable(entry) || typeof entry.listen !== "string") return entry;
  const port = /:(\d+)$/.exec(entry.listen)?.[1];
  return port === undefined ? entry : { ...entry, listen: `0.0.0.0:${port}` };
}

/**
 * `[telemetry]` for the Runtime: each CloudWatch target of the local profile that box takes (the
 * names of `context.telemetry`) with its keys, signed with a bare `aws://`, in the deploy region
 * when it names none; one that box refuses goes; then each CloudWatch target of the
 * context that the local profile does not declare, as box resolves it. A target of another kind
 * stays as it is. With no `cloudwatch_logs` target, {@link DEFAULT_TELEMETRY_TARGET} comes next, as
 * `agentcore`, or as `agentcore_default` when a target has that name, unless the envVars of the
 * runtime turn observability off ({@link OBSERVABILITY_OFF_ENV}). With OTEL on and no
 * `cloudwatch_traces` target, {@link DEFAULT_TRACES_TARGET} comes last, as `agentcore_traces`, or
 * as `agentcore_traces_default` when a target has that name ({@link otelOn}).
 */
function runtimeTelemetry(
  telemetry: unknown,
  context: RuntimeProfileContext,
  warnings: string[],
): unknown {
  if (telemetry !== undefined && !isTable(telemetry)) return telemetry;
  const local: TomlTable = telemetry ?? {};
  const resolved = new Map(context.telemetry.map((target) => [target.name, target]));
  const result: TomlTable = {};
  for (const [name, entry] of Object.entries(local)) {
    if (isTable(entry) && entry.kind === FILE_TELEMETRY_KIND) {
      warnings.push(
        `[telemetry.${name}] writes its records to a file. On AgentCore Runtime that file is in ` +
          "the microVM, where nothing reads it, so build leaves the target out of the Runtime " +
          "profile.",
      );
      continue;
    }
    // A table with no kind adds to the CloudWatch target of that name that a pack gives.
    const addsToPack = isTable(entry) && entry.kind === undefined && resolved.has(name);
    if (!isTable(entry) || (!CLOUDWATCH_KINDS.has(entry.kind) && !addsToPack)) {
      result[name] = entry;
      continue;
    }
    // A CloudWatch target that box refuses gets no grant, and the refusals rule stops build for it.
    if (!resolved.has(name)) continue;
    const { kind, region, ...rest } = entry;
    result[name] = {
      ...(kind !== undefined && { kind }),
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
  const has = (kind: string) =>
    Object.entries(result).some(
      ([name, entry]) => isTable(entry) && (entry.kind ?? resolved.get(name)?.kind) === kind,
    );
  if (!has("cloudwatch_logs") && !observabilityOff(context.runtime)) {
    const name = Object.hasOwn(result, "agentcore") ? "agentcore_default" : "agentcore";
    result[name] = structuredClone(DEFAULT_TELEMETRY_TARGET);
  }
  if (!has("cloudwatch_traces") && otelOn(context.runtime)) {
    const name = Object.hasOwn(result, "agentcore_traces")
      ? "agentcore_traces_default"
      : "agentcore_traces";
    result[name] = structuredClone(DEFAULT_TRACES_TARGET);
  }
  return result;
}

/** `value` when it is a table, or an empty table. */
const tableOf = (value: unknown): TomlTable => (isTable(value) ? value : {});

/** `value` when it is a list, or an empty list. */
const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

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
