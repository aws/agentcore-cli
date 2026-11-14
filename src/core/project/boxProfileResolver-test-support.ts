/**
 * A stand-in for `box profile show --full`, for the tests of the Box network, and the network
 * rules that box 0.1.11 prints. `boxProfileResolver.test.ts` compares the rules with the real box
 * when one is on PATH.
 */
import { stringify } from "smol-toml";
import type { BoxProfileResolver, ResolvedBoxProfile } from "./boxProfileResolver";

const NC = 'action == Box::Action::"net:connect"';
const HR = 'action == Box::Action::"http:request"';

/** The forbids Box writes into every policy, for the cloud metadata hosts and addresses. */
export const BOX_METADATA_RULES =
  `@id("metadata_hosts") forbid (principal, ${NC}, resource) when { context.input.host == "metadata.google.internal" || context.input.host == "metadata.azure.internal" };\n` +
  `@id("metadata_addresses") forbid (principal, ${NC}, resource) when { (context.input has ip4 && context.input.ip4 like "169.254.*") || (context.input has ip6 && (context.input.ip6 == "fd00:ec2::254" || context.input.ip6 like "fe8*" || context.input.ip6 like "fe9*" || context.input.ip6 like "fea*" || context.input.ip6 like "feb*")) };\n`;

/**
 * The permits Box writes for the route `route_<name>` or the HTTP MCP server `mcp_<name>`, from its
 * destinations: a connection to each host and port, and each request to each host.
 */
export function boxReachRules(
  kind: "route" | "mcp",
  name: string,
  destinations: readonly string[],
): string {
  const connect: string[] = [];
  const request: string[] = [];
  for (const destination of destinations) {
    const authority = destination.split("/")[0]!;
    const colon = authority.lastIndexOf(":");
    const hasPort = colon >= 0 && /^\d+$/.test(authority.slice(colon + 1));
    const host = hasPort ? authority.slice(0, colon) : authority;
    const port = hasPort ? Number(authority.slice(colon + 1)) : 443;
    const matches = host.startsWith("*.")
      ? `context.input.host like ${JSON.stringify(host)}`
      : `context.input.host == ${JSON.stringify(host)}`;
    connect.push(`(${matches} && context.input.port == ${port})`);
    request.push(matches);
  }
  const id = (suffix: string) => JSON.stringify(`${kind}_${name}_${suffix}`);
  const call =
    kind === "mcp"
      ? `@id(${id("call")}) permit (principal, action == Box::Action::"mcp:call", resource) when { context.input.server == ${JSON.stringify(name)} };\n`
      : "";
  return (
    call +
    `@id(${id("connect")}) permit (principal, ${NC}, resource) when { ${connect.join(" || ")} };\n` +
    `@id(${id("request")}) permit (principal, ${HR}, resource) when { ${request.join(" || ")} };\n`
  );
}

/** Box's metadata forbids, then its permits for each route of `egress` and HTTP server of `mcp`. */
export function boxNetworkRules(
  egress: Readonly<Record<string, unknown>>,
  mcp: Readonly<Record<string, unknown>> = {},
): string {
  const destinations = (entry: unknown) =>
    ((entry as { destinations?: unknown[] }).destinations ?? []).filter(
      (d): d is string => typeof d === "string",
    );
  const routes = Object.entries(egress)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, entry]) => boxReachRules("route", name, destinations(entry)));
  const servers = Object.entries(mcp)
    .filter(([, entry]) => (entry as { type?: unknown }).type === "http")
    .map(([name, entry]) => boxReachRules("mcp", name, destinations(entry)));
  return BOX_METADATA_RULES + [...routes, ...servers].join("");
}

/**
 * What `box profile show --full` prints for a profile whose routes resolve to `egress`: `box.toml`
 * holds each route with a secret, a backend, or a protocol, as Box keeps the others only as rules,
 * and `policy.dw` holds the profile's own `policy`, then the rules Box adds.
 */
export function boxShowOf(input: {
  readonly egress?: Readonly<Record<string, unknown>>;
  readonly mcp?: Readonly<Record<string, unknown>>;
  readonly policy?: string;
}): ResolvedBoxProfile {
  const egress = input.egress ?? {};
  const mcp = input.mcp ?? {};
  const kept = Object.fromEntries(
    Object.entries(egress).filter(([, entry]) =>
      ["secret", "backends", "protocol"].some((key) => key in (entry as object)),
    ),
  );
  return {
    boxToml: stringify({ name: "test-preview", egress: kept, mcp }),
    policy: `${input.policy ?? ""}\n${boxNetworkRules(egress, mcp)}`,
  };
}

/** Answers each `resolve` with `answer`, which a test may change, and records each call. */
export class FakeBoxProfileResolver implements BoxProfileResolver {
  public readonly calls: { projectRoot: string; profilePath: string }[] = [];

  constructor(public answer: ResolvedBoxProfile | Error = boxShowOf({})) {}

  public resolve(projectRoot: string, profilePath: string): Promise<ResolvedBoxProfile> {
    this.calls.push({ projectRoot, profilePath });
    return this.answer instanceof Error
      ? Promise.reject(this.answer)
      : Promise.resolve(this.answer);
  }
}
