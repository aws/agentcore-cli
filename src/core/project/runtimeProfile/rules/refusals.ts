/**
 * Rule 1 of the derivation: the keys of the local profile, as the user wrote it, that cannot work
 * on AgentCore Runtime. Each one is a problem that names the key, and build stops for it. Nothing
 * is removed: the rule gives the table as it got it.
 *
 * | Key | Problem |
 * | --- | --- |
 * | `network.contain_egress = false` on `[agent]`, a stdio `[mcp.<name>]`, or a `[tool.<name>]` | RUNTIME_EGRESS_NOT_CONTAINED |
 * | a `[telemetry.<name>]` that is not `cloudwatch_logs` or `cloudwatch_traces` | RUNTIME_TELEMETRY_NOT_CLOUDWATCH |
 * | CodeZip: a path of the project outside the code folder, of the home folder, or in the venv | RUNTIME_PATH_NOT_FOUND |
 * | CodeZip: a stdio server or tool program that is not the venv's Python or a file in the code folder | RUNTIME_PROGRAM_NOT_FOUND |
 *
 * A container image runs the same paths and programs under `agentcore dev` and on the Runtime, so
 * the last two do not apply to it. It replaces the CloudWatch-only filter of `cloudWatchTelemetry`
 * (boxNetwork/telemetry.ts), which leaves out each other target with no message.
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
import type {
  RuleResult,
  RuntimeProfileContext,
  RuntimeProfileProblem,
  RuntimeProfileProblemCode,
  TomlTable,
} from "../types";

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
    if (typeof kind === "string" && RUNTIME_TELEMETRY_KINDS.has(kind)) continue;
    problem(
      "RUNTIME_TELEMETRY_NOT_CLOUDWATCH",
      ["telemetry", name, "kind"],
      `${typeof kind === "string" ? `is ${JSON.stringify(kind)}` : "is not set"}. At this time, ` +
        "a box on AgentCore Runtime can send telemetry only to CloudWatch: kind " +
        `"cloudwatch_logs" or "cloudwatch_traces". Remove [telemetry.${name}], or change its ` +
        "kind to one of these.",
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
      // The additions rule writes the command of [agent], so this check is for a leaf only.
      if (!leaf) continue;
      const command = programOf(process);
      const moved = command === undefined ? undefined : moveProjectPath(command, paths);
      const searched = typeof process.program === "string" ? process.program : undefined;
      // A program with no place on the Runtime is a path problem of its command already.
      const program = typeof moved === "string" ? moved : undefined;
      if (program !== undefined && !isRuntimeProgram(program, paths)) {
        problem("RUNTIME_PROGRAM_NOT_FOUND", [...key, "command"], notFound(command!, paths));
      }
      if (searched !== undefined) {
        problem("RUNTIME_PROGRAM_NOT_FOUND", [...key, "program"], notFound(searched, paths));
      }
    }
  }

  return {
    table: structuredClone(table) as TomlTable,
    problems: inProfileOrder(problems),
    warnings: [],
  };
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
