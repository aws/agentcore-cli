import type { SourceSpan } from "./dogwood";

/** AgentCore's limit on the targets of one gateway. */
export const MAX_GATEWAY_TARGETS = 100;

/** The only methods a gateway routes on a passthrough target; PUT, PATCH, and HEAD get a 404. */
export const ROUTABLE_METHODS = ["GET", "POST", "DELETE"] as const;
export type RoutableMethod = (typeof ROUTABLE_METHODS)[number];

/** Why the box profile, a policy file, a rule, an entry, or a target cannot convert. */
export const FAILURE_CODES = [
  "INVALID_PROFILE",
  "UNSUPPORTED_PACK",
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
  "EGRESS_DESTINATION_OVERLAP",
  "EGRESS_WILDCARD_DESTINATION",
  "EGRESS_HAS_BACKEND",
  "EGRESS_ENTRY_FAILED",
  "PATH_SCOPED_SECRET",
  "UNSIGNABLE_HOST",
  "UNSUPPORTED_SECRET",
  "UNSUPPORTED_SECRET_PLACEMENT",
  "API_KEY_CREDENTIAL_MISSING",
  "EXISTING_TARGET_CONFLICT",
  "MANAGED_TARGET_CHANGED",
  "TARGET_NAME_INVALID",
  "TARGET_NAME_COLLISION",
  "TOO_MANY_TARGETS",
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
  readonly reason: string;
  readonly span?: SourceSpan;
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
