import { RUNTIME_PROFILE_PROBLEM_CODES } from "../runtimeProfile/types";
import type { SourceSpan } from "./dogwood";

/** AgentCore's limit on the targets of one gateway. */
export const MAX_GATEWAY_TARGETS = 100;

/**
 * The methods a gateway routes to a passthrough target. Every other method (PUT, PATCH, HEAD,
 * OPTIONS, …) is not routed.
 */
export const ROUTABLE_METHODS = ["GET", "POST", "DELETE"] as const;
export type RoutableMethod = (typeof ROUTABLE_METHODS)[number];

/** Why the box profile, a policy file, a rule, an entry, or a target cannot convert. */
export const FAILURE_CODES = [
  "INVALID_PROFILE",
  "UNSUPPORTED_POLICY_KEY",
  "INVALID_POLICY_FILE",
  "PARSE_ERROR",
  "DUPLICATE_RULE_ID",
  "INVALID_INPUT",
  "UNKNOWN_ACTION",
  "UNKNOWN_ATTRIBUTE",
  "CONDITION_TOO_COMPLEX",
  "WILDCARD_HOST",
  "UNCONSTRAINED_HOST",
  "UNCONSTRAINED_PORT",
  "INVALID_HOST",
  "METHOD_NOT_ROUTABLE",
  "PLAIN_HTTP_ONLY",
  "MCP_OVER_HTTP",
  "MCP_DESTINATION_NOT_ONE_HOST",
  "MCP_PORT_NOT_443",
  "EGRESS_DESTINATION_OVERLAP",
  "EGRESS_WILDCARD_DESTINATION",
  "EGRESS_HAS_BACKEND",
  "EGRESS_ENTRY_FAILED",
  "PATH_SCOPED_SECRET",
  "UNSIGNABLE_HOST",
  "UNSUPPORTED_SECRET",
  "UNSUPPORTED_SECRET_PLACEMENT",
  "API_KEY_CREDENTIAL_SHARED",
  "EXISTING_TARGET_CONFLICT",
  "MANAGED_TARGET_CHANGED",
  "TARGET_NAME_INVALID",
  "TARGET_NAME_COLLISION",
  "TOO_MANY_TARGETS",
  ...RUNTIME_PROFILE_PROBLEM_CODES,
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export interface ConversionFailure {
  readonly code: FailureCode;
  /** The rule's `@id`, when the failure belongs to one rule. */
  readonly ruleId?: string;
  /** The `[egress.<name>]` entry, when the failure belongs to one entry. */
  readonly egressEntry?: string;
  /** The `[mcp.<name>]` entry, when the failure belongs to one MCP server. */
  readonly mcpEntry?: string;
  /**
   * What the rule or entry does wrong, and how to fix it, written to follow its name: `allows
   * every host. Name each host.` The model puts the name and the place before it.
   */
  readonly reason: string;
  readonly span?: SourceSpan;
  /** For a duplicate `@id`, the span of the first rule with that `@id`. */
  readonly firstSpan?: SourceSpan;
}

/** Why build cannot convert the box profile, and where. */
export interface BoxNetworkFailure {
  readonly code: FailureCode;
  readonly ruleId?: string;
  readonly egressEntry?: string;
  readonly mcpEntry?: string;
  readonly target?: string;
  /** The problem and how to fix it, in whole sentences that name its rule, entry, or target. */
  readonly reason: string;
  /**
   * The user's own file, as `file:line:column` or the file alone: a rule Box adds is at the part
   * of the profile that makes Box add it.
   */
  readonly place?: string;
}

/** A sample request the converter evaluates the whole Box policy on: a method and a path. */
export interface SampleRequest {
  readonly method: RoutableMethod;
  readonly path: string;
}

/** The sample requests Box allows to a host, out of how many the converter evaluated. */
export interface HostDecision {
  readonly samples: number;
  /** Each allowed sample, with the permit that allows it. */
  readonly allowed: readonly (SampleRequest & { readonly ruleId: string })[];
}

/** The host map's key: the lower-case host, and `:port` for a port other than 443. */
export function hostKey(host: string, port: number): string {
  return port === 443 ? host.toLowerCase() : `${host.toLowerCase()}:${port}`;
}
