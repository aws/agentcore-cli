/**
 * Rule 1 of the derivation: the keys of the local profile that cannot work on AgentCore Runtime
 * whatever their paths are. To do: a stdio `[mcp.<name>]` or a `[tool.<name>]` with
 * `network.contain_egress = false` (RUNTIME_EGRESS_NOT_CONTAINED); on a CodeZip runtime, a stdio
 * server or tool program that is not the venv's Python or a file in the code folder
 * (RUNTIME_PROGRAM_NOT_FOUND); and each `[telemetry.<name>]` that is not CloudWatch, which it
 * removes with a warning, as `cloudWatchTelemetry` in boxNetwork/telemetry.ts leaves it out today.
 */
import type { RuleResult, RuntimeProfileContext, TomlTable } from "../types";

export function apply(table: Readonly<TomlTable>, _context: RuntimeProfileContext): RuleResult {
  return { table: { ...table }, problems: [], warnings: [] };
}
