import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { CredentialNameSchema } from "../../projectSchemas/credential";
import type { AgentCoreGatewayTarget } from "../../projectSchemas/gateway";
import {
  BOX_GATEWAY_AGENTCORE_TARGET_NAME,
  BOX_GATEWAY_BEDROCK_TARGET_NAME,
} from "../../handlers/project/shortcuts";

/** The box profile, relative to the project root. */
const BOX_PROFILE_RELATIVE_PATH = join(".box", "profile.toml");
const ENV_SCHEME = "env://";

/**
 * The names the generated box routes own, which a user egress may not reuse:
 * the AgentCore Memory route and the Bedrock model route. A user egress with
 * one of these names is skipped, so it does not shadow a generated route.
 */
const RESERVED_ROUTE_NAMES: ReadonlySet<string> = new Set([
  BOX_GATEWAY_AGENTCORE_TARGET_NAME,
  BOX_GATEWAY_BEDROCK_TARGET_NAME,
]);

/** The header the gateway adds the API key to when the box profile names none. */
const DEFAULT_API_KEY_HEADER = "Authorization";

/**
 * An HTTP header name (RFC 9110 token), the same rule the gateway schema uses.
 * A `secret.header` that is not a valid header name falls back to the default.
 */
const HTTP_HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/**
 * A box egress that the Box gateway fronts on AgentCore Runtime: its name (also
 * the gateway target name and the API key credential name), the hosts the agent
 * calls, the upstream endpoint the gateway forwards to, the box env var that
 * holds the key locally, and the header the gateway adds the key to.
 */
export type BoxEgressRoute = {
  name: string;
  destinations: string[];
  endpoint: string;
  variable: string;
  header: string;
};

/** The environment variable an `env://VAR` reference names, or undefined for any other ref. */
function envVarFromRef(ref: unknown): string | undefined {
  if (typeof ref !== "string" || !ref.startsWith(ENV_SCHEME)) return undefined;
  const variable = ref.slice(ENV_SCHEME.length);
  return variable.length > 0 ? variable : undefined;
}

/**
 * The egress destinations as a non-empty string list, from either `destinations`
 * (a host list) or `destination` (a single host or URL). Returns undefined when
 * the entry names neither.
 */
function readDestinations(entry: unknown): string[] | undefined {
  const record = entry as { destinations?: unknown; destination?: unknown } | null;
  const many = record?.destinations;
  if (Array.isArray(many) && many.length > 0 && many.every((item) => typeof item === "string")) {
    return many as string[];
  }
  const one = record?.destination;
  if (typeof one === "string" && one.length > 0) return [one];
  return undefined;
}

/** The upstream endpoint URL the gateway forwards to: the destination, with `https://` added if it has no scheme. */
function toEndpoint(destination: string): string {
  return /^https?:\/\//.test(destination) ? destination : `https://${destination}`;
}

/** The header the gateway adds the key to: the profile's `secret.header` when it is a valid header name, else the default. */
function readHeader(secret: { header?: unknown } | undefined): string {
  const header = secret?.header;
  if (typeof header === "string" && HTTP_HEADER_NAME_PATTERN.test(header)) return header;
  return DEFAULT_API_KEY_HEADER;
}

/**
 * The box egress routes that AgentCore Runtime fronts through the Box gateway,
 * read from `.box/profile.toml`. One route per `[egress.<name>]` that both lists
 * destinations and signs with an `env://` API key (`secret.ref = "env://VAR"`),
 * since only such a route needs a key the box cannot hold on the Runtime.
 *
 * Returns an empty list when the profile is absent or malformed; the box reports
 * a malformed profile, so build does not block on it here. It skips:
 *   - a reserved name (`agentcore`, `bedrock`), which a generated route owns;
 *   - a name that is not a valid credential name;
 *   - an entry with no `env://` key (an `aws://` ref, such as the Bedrock route);
 *   - an entry with no destinations.
 */
export function boxEgressRoutes(projectRoot: string): BoxEgressRoute[] {
  const profilePath = join(projectRoot, BOX_PROFILE_RELATIVE_PATH);
  if (!existsSync(profilePath)) return [];

  let parsed: unknown;
  try {
    parsed = parseToml(readFileSync(profilePath, "utf8"));
  } catch {
    return [];
  }
  const egress = (parsed as { egress?: Record<string, unknown> }).egress;
  if (egress === undefined || typeof egress !== "object") return [];

  const routes: BoxEgressRoute[] = [];
  for (const [name, entry] of Object.entries(egress)) {
    if (RESERVED_ROUTE_NAMES.has(name)) continue;
    if (!CredentialNameSchema.safeParse(name).success) continue;
    const secret = (entry as { secret?: { ref?: unknown; header?: unknown } } | null)?.secret;
    const variable = envVarFromRef(secret?.ref);
    if (variable === undefined) continue;
    const destinations = readDestinations(entry);
    if (destinations === undefined) continue;
    routes.push({
      name,
      destinations,
      endpoint: toEndpoint(destinations[0]!),
      variable,
      header: readHeader(secret),
    });
  }
  return routes;
}

/**
 * The Box gateway passthrough target for a box egress: the gateway forwards to
 * the upstream endpoint and adds the API key, which it reads from AgentCore
 * Identity under the credential named like the route. The box signs the call to
 * the gateway with the execution role, so this target holds no secret.
 */
export function getBoxEgressTargetSpec(route: BoxEgressRoute): AgentCoreGatewayTarget {
  return {
    name: route.name,
    targetType: "passthrough",
    passthrough: { endpoint: route.endpoint, protocolType: "CUSTOM" },
    // location defaults to HEADER; service and region are not valid with API_KEY auth.
    outboundAuth: {
      type: "API_KEY",
      credentialName: route.name,
      parameterName: route.header,
    },
  };
}
