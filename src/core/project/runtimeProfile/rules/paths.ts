/**
 * Rule 4 of the derivation, the last: each path of the project and of the home folder, where it is
 * on AgentCore Runtime (`context.paths`). A container image keeps each path. On CodeZip, the venv's
 * Python goes to `${{ inputs.python.path }}`, the venv and the code folder go to
 * `${{ inputs.code.dir }}`, and the uv Pythons go to `${{ inputs.python.prefix }}`. The paths move
 * in each key that can hold a path (projectPaths.ts): the `[agent]` command, env, and filesystem
 * lists, and each key of each stdio `[mcp.<name>]` and `[tool.<name>]`. Then each filesystem list
 * has one grant for each path. A leaf that runs the Runtime's Python gets the `PYTHONPATH` of the
 * code folder when it sets none, and the `_ctypes` folder in front of a `PYTHONPATH` of its own, as
 * the additions rule does for `[agent]`. Each entry of a path list moves, and an entry that names a
 * Runtime input stays. The refusals rule stops build for a path that has no place on the
 * Runtime, so this rule keeps such a path as it is. It replaces the path moves of
 * runtimeCodeZipRunner (templates/boxProfile.ts).
 */
import {
  isTable,
  mapProjectPaths,
  moveProjectPath,
  processTables,
  programOf,
  runtimeFfiPath,
  runtimePythonPath,
  withOneGrantForEachPath,
} from "../projectPaths";
import type { RuleResult, RuntimeProfileContext, TomlTable } from "../types";

export function apply(table: Readonly<TomlTable>, context: RuntimeProfileContext): RuleResult {
  const { paths } = context;
  if (paths.build !== "CodeZip") {
    return { table: structuredClone(table) as TomlTable, problems: [], warnings: [] };
  }
  const moved = mapProjectPaths(table, (value) => {
    const result = moveProjectPath(value, paths);
    return typeof result === "string" ? result : value;
  });
  for (const { table: process, leaf } of processTables(moved)) {
    if (isTable(process.filesystem)) {
      process.filesystem = withOneGrantForEachPath(process.filesystem);
    }
    if (!leaf || programOf(process) !== paths.runtimePython) continue;
    const env = isTable(process.env) ? process.env : {};
    const own = env.PYTHONPATH;
    const ffi = runtimeFfiPath(paths);
    if (own === undefined) {
      process.env = { ...env, PYTHONPATH: runtimePythonPath(paths) };
    } else if (typeof own === "string" && !own.split(":").includes(ffi)) {
      process.env = { ...env, PYTHONPATH: `${ffi}:${own}` };
    }
  }
  return { table: moved, problems: [], warnings: [] };
}
