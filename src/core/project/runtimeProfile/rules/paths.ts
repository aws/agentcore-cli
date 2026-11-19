/**
 * Rule 4 of the derivation, the last: each path of the project or the home folder, in every table,
 * where it is on AgentCore Runtime (`context.paths`). A container image keeps each path. On CodeZip,
 * the venv's Python goes to `${{ inputs.python.path }}`, the venv and the code folder to
 * `${{ inputs.code.dir }}`, and the uv Pythons to `${{ inputs.python.prefix }}`, as the agent
 * command moves today in runtimeCodeZipRunner (templates/boxProfile.ts). To do: a path of the
 * project outside the code folder, a path in the home folder, or a path in the venv has no place
 * there (RUNTIME_PATH_NOT_FOUND); and one grant for each path where two move to one.
 */
import type { RuleResult, RuntimeProfileContext, TomlTable } from "../types";

export function apply(table: Readonly<TomlTable>, _context: RuntimeProfileContext): RuleResult {
  return { table: { ...table }, problems: [], warnings: [] };
}
