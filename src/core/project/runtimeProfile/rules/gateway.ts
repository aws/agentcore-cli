/**
 * Rule 2 of the derivation: the calls of the box go through its Box gateway on AgentCore Runtime.
 * To do: replace each `[egress.<name>]` whose host gets a gateway target with one
 * `[egress.<target>]` route for each target, with one backend to `${{ inputs.gateway.url }}/<target>`
 * signed with a bare `aws://` for the gateway region, and no secret (the target sends it); add the
 * routes of the targets build adds (`bedrock`, `agentcore`, permit-only hosts); give each HTTP
 * `[mcp.<name>]` its gateway backend and keep its `env://` secret. It absorbs, from
 * templates/boxProfile.ts: runtimeGatewayRoutes, runtimeGatewayRouteSection,
 * runtimeMcpServerSection, runtimeMcpServers, and runtimeGatewayBackend.
 */
import type { RuleResult, RuntimeProfileContext, TomlTable } from "../types";

export function apply(table: Readonly<TomlTable>, _context: RuntimeProfileContext): RuleResult {
  return { table: { ...table }, problems: [], warnings: [] };
}
