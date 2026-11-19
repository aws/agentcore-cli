/**
 * Rule 3 of the derivation: what only AgentCore Runtime needs, and the Runtime value of each
 * setting that works only under `agentcore dev`. To do: `[profile] name` is the project's name;
 * `packs` adds box/agentcore, and box/agentcore-codezip for CodeZip; `[options] bedrock.region` is
 * the build region; `policies` names the policy files that staging copies; in `[agent]`, each value
 * that is the template's own (`context.template.local`) becomes the template's Runtime value
 * (`context.template.runtime`): the command with no `--reload`, the env with no `LOCAL_DEV` and with
 * the region, the AWS stand-ins and the ffi `PYTHONPATH`, the filesystem grants, and the ingress on
 * 0.0.0.0, and each value of the user's own stays; each CloudWatch `[telemetry.<name>]` is signed
 * with a bare `aws://` in the deploy region. It absorbs, from templates/boxProfile.ts: the Runtime
 * branch of renderBoxProfile (runtimeCodeZipRunner, containerRunner with dev false,
 * runtimeRegionEnv, RUNTIME_AWS_STAND_IN_LINES, the packs, the header, the name, the options, the
 * ingress) and runtimeTelemetrySection.
 */
import type { RuleResult, RuntimeProfileContext, TomlTable } from "../types";

export function apply(table: Readonly<TomlTable>, _context: RuntimeProfileContext): RuleResult {
  return { table: { ...table }, problems: [], warnings: [] };
}
