/**
 * Rule 4 of the derivation, the last: each path of the project and of the home folder, where it is
 * on AgentCore Runtime (`context.paths`). A container image keeps each path. On CodeZip, the venv's
 * Python goes to `${{ inputs.python.path }}`, the venv and the code folder go to
 * `${{ inputs.code.dir }}`, and the uv Pythons go to `${{ inputs.python.stdlib }}`. The paths move
 * in each key that can hold a path (projectPaths.ts): the `[agent]` command, env, and filesystem
 * lists, and each key of each stdio `[mcp.<name>]` and `[tool.<name>]`. Then each filesystem list
 * has one grant for each path. A leaf that runs the Runtime's Python gets the `PYTHONPATH` of the
 * code folder when it sets none, as the additions rule does for `[agent]`. A `PYTHONPATH` of its
 * own, and the one of `[agent]`, keep each entry one time and end with the code folder. Each entry
 * of a path list moves, and an entry that names a Runtime input stays. The refusals rule stops build for a path that has no place on the
 * Runtime, so this rule keeps such a path as it is. runtimeCodeZipRunner (templates/boxProfile.ts)
 * gives the Runtime grants of the template in the local paths, and this rule moves them too.
 */
import {
  grantPath,
  isDroppableGrant,
  isTable,
  keyLabel,
  mapProjectPaths,
  moveProjectPath,
  pathProblem,
  processTables,
  programOf,
  runtimePythonPath,
  withOneGrantForEachPath,
} from "../projectPaths";
import type { RuleResult, RuntimePaths, RuntimeProfileContext, TomlTable } from "../types";

export function apply(table: Readonly<TomlTable>, context: RuntimeProfileContext): RuleResult {
  const { paths } = context;
  if (paths.build !== "CodeZip") {
    return { table: structuredClone(table) as TomlTable, problems: [], warnings: [] };
  }
  const warnings: string[] = [];
  const moved = mapProjectPaths(withoutVenvDeny(table, paths, warnings), (value) => {
    const result = moveProjectPath(value, paths);
    return typeof result === "string" ? result : value;
  });
  for (const { key, table: process, leaf } of processTables(moved)) {
    if (isTable(process.filesystem)) {
      process.filesystem = withOneGrantForEachPath(
        withoutLostGrants(process.filesystem, key, paths, warnings),
      );
    }
    // The additions rule gives [agent] its PYTHONPATH; a leaf gets one when it runs that Python.
    if (leaf && programOf(process) !== paths.runtimePython) continue;
    const env = isTable(process.env) ? process.env : {};
    const own = env.PYTHONPATH;
    if (own === undefined) {
      if (leaf) process.env = { ...env, PYTHONPATH: runtimePythonPath(paths) };
    } else if (typeof own === "string") {
      process.env = { ...env, PYTHONPATH: withRuntimePythonPath(own, paths) };
    }
  }
  return { table: moved, problems: [], warnings };
}

/**
 * The `PYTHONPATH` `own` of a process that runs the Runtime's Python, with each entry one time in
 * its order, and the code folder, where the Runtime installs the dependencies, at the end when
 * `own` does not name it.
 */
function withRuntimePythonPath(own: string, paths: RuntimePaths): string {
  const entries = [...new Set(own.split(":").filter((entry) => entry !== ""))];
  return [...entries, ...(entries.includes(paths.runtimeCode) ? [] : [paths.runtimeCode])].join(
    ":",
  );
}

/**
 * `table` with no `deny` entry on the venv or in it, with a warning for each: on a CodeZip Runtime
 * the venv is the code folder, so such an entry would keep the process from its own code. A
 * `deny_write` entry on the venv stays.
 */
function withoutVenvDeny(
  table: Readonly<TomlTable>,
  paths: RuntimePaths,
  warnings: string[],
): TomlTable {
  const result = structuredClone(table) as TomlTable;
  const venv = (path: string) => {
    const normal = path.replace(/\$\{\{\s*workspace\s*\}\}/g, "${{ workspace }}");
    return normal === paths.localVenv || normal.startsWith(`${paths.localVenv}/`);
  };
  for (const { key, table: process } of processTables(result)) {
    const filesystem = process.filesystem;
    if (!isTable(filesystem) || !Array.isArray(filesystem.deny)) continue;
    const deny = filesystem.deny.filter((grant) => {
      const path = grantPath(grant);
      if (path === undefined || !venv(path)) return true;
      warnings.push(
        `${keyLabel([...key, "filesystem", "deny"])} names ${JSON.stringify(path)}, in the venv. ` +
          `On AgentCore Runtime the venv is the code folder, ${paths.runtimeCode}, so the entry ` +
          "would keep the process from its own code. Build leaves it out of the Runtime profile.",
      );
      return false;
    });
    if (deny.length > 0) filesystem.deny = deny;
    else delete filesystem.deny;
  }
  return result;
}

/**
 * `filesystem` with no deny entry and no optional grant whose path is not on the Runtime, with a
 * warning for each. The refusals rule stops build for each other grant with no place there. A
 * moved path names no `${{ workspace }}` or `${{ home }}`, so only a grant that did not move is
 * left out.
 */
function withoutLostGrants(
  filesystem: Readonly<TomlTable>,
  key: readonly string[],
  paths: RuntimePaths,
  warnings: string[],
): TomlTable {
  const result: TomlTable = {};
  for (const [list, grants] of Object.entries(filesystem)) {
    if (!Array.isArray(grants)) {
      result[list] = grants;
      continue;
    }
    const kept = grants.filter((grant) => {
      const path = grantPath(grant);
      if (path === undefined || pathProblem(path, paths) === undefined) return true;
      if (!isDroppableGrant(list, grant)) return true;
      warnings.push(
        `${keyLabel([...key, "filesystem", list])} names ${JSON.stringify(path)}, which is not on ` +
          "AgentCore Runtime, so build leaves it out of the Runtime profile.",
      );
      return false;
    });
    // A list that build empties goes.
    if (kept.length > 0 || grants.length === 0) result[list] = kept;
  }
  return result;
}
