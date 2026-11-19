/**
 * The AgentCore Runtime box profile of a runtime, derived from its local box profile,
 * `.box/<runtime>/local/profile.toml`. Each key of the local profile goes to the Runtime profile,
 * and each rule changes only what must be different on AgentCore Runtime. A key that cannot work
 * there, and that no rule can map, is a problem, and build stops for it.
 *
 * | Rule | What it does |
 * | --- | --- |
 * | `refusals` | stops for a key that cannot work on the Runtime whatever its paths are |
 * | `gateway` | sends each call of the box through the runtime's Box gateway |
 * | `additions` | adds what only the Runtime needs, and replaces each value that works only under dev |
 * | `paths` | moves each path of the project to where the code is on the Runtime |
 */
import * as additions from "./rules/additions";
import * as gateway from "./rules/gateway";
import * as paths from "./rules/paths";
import * as refusals from "./rules/refusals";
import type {
  RuntimeProfileContext,
  RuntimeProfileProblem,
  RuntimeProfileRule,
  TomlTable,
} from "./types";

/**
 * The rules, in the order they run. `refusals` reads the local profile as the user wrote it.
 * `gateway` and `additions` write Runtime values, which name only the Runtime's inputs. `paths`
 * runs last, so it moves each path that the user's own keys name, and no Runtime value.
 */
export const RUNTIME_PROFILE_RULES: readonly {
  readonly name: string;
  readonly apply: RuntimeProfileRule;
}[] = [
  { name: "refusals", apply: refusals.apply },
  { name: "gateway", apply: gateway.apply },
  { name: "additions", apply: additions.apply },
  { name: "paths", apply: paths.apply },
];

/** The Runtime profile of the local profile `local`, with each problem and warning of each rule. */
export function deriveRuntimeProfile(
  local: Readonly<TomlTable>,
  context: RuntimeProfileContext,
): { profile: TomlTable; problems: RuntimeProfileProblem[]; warnings: string[] } {
  let profile: TomlTable = structuredClone(local) as TomlTable;
  const problems: RuntimeProfileProblem[] = [];
  const warnings: string[] = [];
  for (const rule of RUNTIME_PROFILE_RULES) {
    const result = rule.apply(profile, context);
    profile = result.table;
    problems.push(...result.problems);
    warnings.push(...result.warnings);
  }
  return { profile, problems, warnings };
}

/** A key as a message names it: `[mcp.notes] command`, `[agent.filesystem] read`, `packs`. */
export function keyLabel(key: readonly string[]): string {
  if (key.length === 1) return key[0]!;
  const table = key.slice(0, -1).join(".");
  return `[${table}] ${key[key.length - 1]}`;
}
