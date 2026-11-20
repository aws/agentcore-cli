/**
 * Rule 1 of the derivation: the keys of the local profile, as the user wrote it, that cannot work
 * on AgentCore Runtime. Each one is a problem that names the key, and build stops for it. Nothing
 * is removed: the rule gives the table as it got it.
 *
 * | Key | Problem |
 * | --- | --- |
 * | `network.contain_egress = false` on `[agent]`, a stdio `[mcp.<name>]`, or a `[tool.<name>]` | RUNTIME_EGRESS_NOT_CONTAINED |
 * | a `[telemetry.<name>]` that is not `cloudwatch_logs` or `cloudwatch_traces`, and that the Box network model does not carry (`context.thirdPartyTelemetry`) | RUNTIME_TELEMETRY_NOT_CLOUDWATCH |
 * | a CloudWatch `[telemetry.<name>]` that box refuses when a run starts, so it is not in `context.telemetry` | RUNTIME_TELEMETRY_REFUSED |
 * | CodeZip: a path of the project outside the code folder, of the home folder (`${{ home }}`, `~`, `/Users`, `/home`), or in the venv | RUNTIME_PATH_NOT_FOUND |
 * | CodeZip: an `[agent]`, stdio server, or tool program that is not the venv's Python or a file in the code folder | RUNTIME_PROGRAM_NOT_FOUND |
 * | CodeZip: a `write` or `write_file` grant in the code folder, which the agent runs files from on the Runtime | RUNTIME_WRITE_IN_CODE |
 *
 * A container image runs the same paths and programs under `agentcore dev` and on the Runtime, so
 * the last three do not apply to it. The rule reads only the text of the local profile: a key that
 * a pack adds is not in that text, so the rule does not examine it.
 */
import { keyLabel } from "../derive";
import {
  isRuntimeProgram,
  isTable,
  mapProjectPaths,
  moveProjectPath,
  processTables,
  programOf,
  type PathProblem,
} from "../projectPaths";
import { THIRD_PARTY_KINDS } from "../../boxNetwork/telemetry";
import { BOX_SECRETS_MANAGER_ENV, BOX_SECRETS_MANAGER_PLUGIN } from "../../boxTelemetrySecrets";
import type {
  RuleResult,
  RuntimeProfileContext,
  RuntimeProfileProblem,
  RuntimeProfileProblemCode,
  TomlTable,
} from "../types";

/** The filesystem lists that let a process write. */
const WRITE_LISTS = ["write", "write_file"] as const;

/** The telemetry kinds that a box on AgentCore Runtime can send to, with the execution role. */
const RUNTIME_TELEMETRY_KINDS: ReadonlySet<string> = new Set([
  "cloudwatch_logs",
  "cloudwatch_traces",
]);

export function apply(table: Readonly<TomlTable>, context: RuntimeProfileContext): RuleResult {
  const problems: RuntimeProfileProblem[] = [];
  const problem = (code: RuntimeProfileProblemCode, key: readonly string[], reason: string) =>
    problems.push({ code, key, reason: `${keyLabel(key)} ${reason}`, place: context.placeOf(key) });

  for (const { key, table: process } of processTables(table)) {
    const network = process.network;
    if (isTable(network) && network.contain_egress === false) {
      problem(
        "RUNTIME_EGRESS_NOT_CONTAINED",
        [...key, "network", "contain_egress"],
        `is false: on AgentCore Runtime, [${key.join(".")}] connects to hosts without the Box ` +
          "gateway. Build does not send such a process to AgentCore Runtime. Remove " +
          "contain_egress, and give each host that the process connects to an [egress] entry.",
      );
    }
  }

  const telemetry = isTable(table.telemetry) ? table.telemetry : {};
  for (const [name, target] of Object.entries(telemetry)) {
    const kind = isTable(target) ? target.kind : undefined;
    if (typeof kind === "string" && RUNTIME_TELEMETRY_KINDS.has(kind)) {
      // context.telemetry holds each CloudWatch target that box takes (cloudWatchTelemetry).
      if (context.telemetry.some((resolved) => resolved.name === name)) continue;
      problem(
        "RUNTIME_TELEMETRY_REFUSED",
        ["telemetry", name],
        "is a CloudWatch target that box refuses when a run starts, under `agentcore dev` and " +
          "on AgentCore Runtime. Give it a region of lower-case letters, digits, and -, and an " +
          "include of one or more different words of deny, permit, trace, logs, and metrics. " +
          "For cloudwatch_logs, give it a log_group of letters, digits, and . _ - / #, and a " +
          "log_stream with no : or *.",
      );
      continue;
    }
    // The additions rule carries each third-party target that the Box network model carries.
    if (context.thirdPartyTelemetry?.some((carried) => carried.name === name)) continue;
    // A table with no kind adds to the target of that name that a pack gives, which box resolves.
    if (kind === undefined && context.telemetry.some((resolved) => resolved.name === name))
      continue;
    problem(
      "RUNTIME_TELEMETRY_NOT_CLOUDWATCH",
      ["telemetry", name, "kind"],
      notCloudWatch(name, kind, context),
    );
  }

  const { paths } = context;
  if (paths.build === "CodeZip") {
    const code = paths.shownCode;
    const reasons: Record<PathProblem, (value: string) => string> = {
      "outside-code": (value) =>
        `names ${value}, which is not in ${code}. The zip of a CodeZip deploy contains only ` +
        `that folder. Move the file into ${code}, or remove the path.`,
      home: (value) =>
        `names ${value} in the home folder. The home folder on AgentCore Runtime is empty. Move ` +
        `the file into ${code}, or remove the path.`,
      venv: (value) =>
        `names ${value}, a path in the venv. The zip of a CodeZip deploy does not contain the ` +
        `venv: the Runtime installs the dependencies in ${code}. Use the venv's Python, the ` +
        `venv, or a path in ${code}.`,
    };
    mapProjectPaths(table, (value, key) => {
      const moved = moveProjectPath(value, paths);
      if (typeof moved !== "string") {
        problem("RUNTIME_PATH_NOT_FOUND", key, reasons[moved.problem](JSON.stringify(value)));
      }
      return value;
    });
    for (const { key, table: process, leaf } of processTables(table)) {
      // The command of the template moves to the Runtime's Python. A command of the user stays.
      const command = programOf(process);
      const moved = command === undefined ? undefined : moveProjectPath(command, paths);
      const searched = leaf && typeof process.program === "string" ? process.program : undefined;
      // A program with no place on the Runtime is a path problem of its command already.
      const program = typeof moved === "string" ? moved : undefined;
      if (program !== undefined && !isRuntimeProgram(program, paths)) {
        problem("RUNTIME_PROGRAM_NOT_FOUND", [...key, "command"], notFound(command!, paths));
      }
      if (searched !== undefined) {
        problem("RUNTIME_PROGRAM_NOT_FOUND", [...key, "program"], notFound(searched, paths));
      }
    }
    // On the Runtime the agent gets exec on the code folder, and box refuses a write grant in a
    // folder that it can run files from.
    for (const { key, table: process } of processTables(table)) {
      const filesystem = isTable(process.filesystem) ? process.filesystem : {};
      for (const list of WRITE_LISTS) {
        const grants = filesystem[list];
        if (!Array.isArray(grants)) continue;
        for (const grant of grants) {
          const path = grantPath(grant);
          const moved = path === undefined ? undefined : moveProjectPath(path, paths);
          if (typeof moved !== "string" || !inRuntimeCode(moved, paths)) continue;
          problem(
            "RUNTIME_WRITE_IN_CODE",
            [...key, "filesystem", list],
            `names ${JSON.stringify(path)}, a path in ${code}. On AgentCore Runtime, the agent ` +
              `can run each file in ${code}, and box refuses a write grant in a folder that the ` +
              "box can run files from. Remove the path from the list.",
          );
        }
      }
    }
  }

  return {
    table: structuredClone(table) as TomlTable,
    problems: inProfileOrder(problems),
    warnings: [],
  };
}

/**
 * Why `[telemetry.<name>]` of kind `kind` cannot go to AgentCore Runtime. A third-party target goes
 * there only through AWS Secrets Manager: the message names that switch when it is off, and the
 * warning of the Box network model when the switch is on and build cannot carry the target.
 */
function notCloudWatch(name: string, kind: unknown, context: RuntimeProfileContext): string {
  const thirdParty = THIRD_PARTY_KINDS.some((candidate) => candidate === kind);
  if (thirdParty && context.secretsManager) {
    return (
      `is ${JSON.stringify(kind)}, and build cannot carry this target to AgentCore Runtime: the ` +
      `warning for [telemetry.${name}] gives the reason. Correct that, remove ` +
      `[telemetry.${name}], or change its kind to "cloudwatch_logs" or "cloudwatch_traces".`
    );
  }
  const reason =
    `${typeof kind === "string" ? `is ${JSON.stringify(kind)}` : "is not set"}. At this time, ` +
    "a box on AgentCore Runtime can send telemetry only to CloudWatch: kind " +
    `"cloudwatch_logs" or "cloudwatch_traces". Remove [telemetry.${name}], or change its ` +
    "kind to one of these.";
  if (!thirdParty) return reason;
  return (
    `${reason} With a box build that has the ${BOX_SECRETS_MANAGER_PLUGIN} plugin, you can set ` +
    `${BOX_SECRETS_MANAGER_ENV}=1 instead: then build carries the target, and deploy moves its ` +
    "key to AWS Secrets Manager."
  );
}

/** The path of a filesystem grant: the string, or the `path` of a grant table. */
function grantPath(grant: unknown): string | undefined {
  if (typeof grant === "string") return grant;
  return isTable(grant) && typeof grant.path === "string" ? grant.path : undefined;
}

/** Whether `path`, as a CodeZip Runtime profile names it, is the code folder or in it. */
function inRuntimeCode(path: string, paths: RuntimeProfileContext["paths"]): boolean {
  return path === paths.runtimeCode || path.startsWith(`${paths.runtimeCode}/`);
}

/** Why build cannot find the program `program` of a process on a CodeZip Runtime. */
function notFound(program: string, paths: RuntimeProfileContext["paths"]): string {
  return (
    `starts ${JSON.stringify(program)}, which build cannot find on AgentCore Runtime. The zip ` +
    `of a CodeZip deploy contains only ${paths.shownCode}, and the Runtime has its own Python. ` +
    `Start the process with the venv's Python, for example ` +
    `${paths.localVenv}/bin/python3.<minor>, or with a program in ${paths.shownCode}.`
  );
}

/** `problems` in the order of their places in the profile, and each problem of one place once. */
function inProfileOrder(problems: readonly RuntimeProfileProblem[]): RuntimeProfileProblem[] {
  const position = ({ place }: RuntimeProfileProblem) => {
    const match = /:(\d+):(\d+)$/.exec(place);
    return match ? [Number(match[1]), Number(match[2])] : [0, 0];
  };
  const seen = new Set<string>();
  return problems
    .filter(({ code, key, reason }) => {
      const identity = JSON.stringify([code, key, reason]);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .map((problem, index) => ({ problem, index, at: position(problem) }))
    .sort((a, b) => a.at[0]! - b.at[0]! || a.at[1]! - b.at[1]! || a.index - b.index)
    .map(({ problem }) => problem);
}
