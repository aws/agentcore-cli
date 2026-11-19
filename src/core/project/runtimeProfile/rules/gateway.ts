/**
 * Rule 2 of the derivation: on AgentCore Runtime, each call of the box goes through the runtime's
 * Box gateway. Each passthrough target of that gateway, as build writes the gateway, gets one
 * route: the box sends the calls to the target's host to `${{ inputs.gateway.url }}/<target>`, and
 * signs them for the gateway in the build region with a bare `aws://`, the execution role. The
 * gateway then calls the host with the target's own auth.
 *
 * | Local profile | Runtime profile |
 * | --- | --- |
 * | `[egress.<name>]`, for each of its hosts with a target | `[egress.<target>]`, the other keys kept, no `secret` |
 * | HTTP `[mcp.<name>]` | `[mcp.<name>]`, the other keys kept, only an `env://` secret |
 * | a target that no entry of the profile names | `[egress.<target>]`, or the `[mcp]` server it serves |
 * | an entry whose hosts the policy denies | removed; the Box network model warns for it |
 * | an entry with no host in the Box network model | removed; the model fails the entry, and build stops |
 *
 * A stdio `[mcp.<name>]` stays as it is: the `refusals` and `paths` rules own it.
 */
import { InputValidationError } from "../../../../errors/errors";
import type { AgentCoreGatewayTarget } from "../../../../projectSchemas/gateway";
import type { BoxHostSource, BoxNetworkHost } from "../../boxNetwork";
import { BOX_EGRESS_TARGET_PREFIX } from "../../boxNetwork/egress";
import { gatewayTargetFor } from "../../boxNetwork/projectSpec";
import {
  RUNTIME_INPUTS,
  type RuleResult,
  type RuntimeProfileContext,
  type TomlTable,
} from "../types";

/** The signer of each gateway backend: the AWS default credential chain, the execution role. */
const RUNTIME_AWS_SIGNER = "aws://";

type McpSource = Extract<BoxHostSource, { kind: "mcp" }>;

/** One route of the Runtime profile: a passthrough target of the Box gateway and its host. */
interface GatewayRoute {
  readonly target: string;
  /** `host`, or `host:port`, of the target's endpoint. */
  readonly host: string;
  /** The HTTP MCP server of the Box network model that the target serves. */
  readonly server?: McpSource;
}

const isTable = (value: unknown): value is TomlTable =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function apply(table: Readonly<TomlTable>, context: RuntimeProfileContext): RuleResult {
  const routes = gatewayRoutes(context);
  const written = new Set<string>();

  const egress: TomlTable = {};
  for (const [name, entry] of Object.entries(isTable(table.egress) ? table.egress : {})) {
    if (!isTable(entry)) {
      egress[name] = entry;
      continue;
    }
    const hosts = context.hosts.filter((host) =>
      host.sources.some((source) => source.kind === "entry" && source.egressEntry === name),
    );
    for (const route of routesOf(hosts, routes)) {
      egress[route.target] = egressRoute(entry, route, context.region);
      written.add(route.target);
    }
  }

  const mcp: TomlTable = {};
  for (const [name, entry] of Object.entries(isTable(table.mcp) ? table.mcp : {})) {
    if (!isTable(entry) || !isHttpServer(entry)) {
      mcp[name] = entry;
      continue;
    }
    const route = routes.find(({ server }) => server?.mcpEntry === name);
    if (route?.server === undefined) continue;
    mcp[name] = mcpServer(entry, route, route.server, context.region);
    written.add(route.target);
  }

  for (const route of routes) {
    if (written.has(route.target)) continue;
    if (route.server) {
      mcp[route.server.mcpEntry] = mcpServer({}, route, route.server, context.region);
    } else {
      egress[route.target] = egressRoute({}, route, context.region);
    }
  }

  // The two tables keep their place in the profile, and an empty one goes.
  const result: TomlTable = { ...table, egress, mcp };
  if (Object.keys(egress).length === 0) delete result.egress;
  if (Object.keys(mcp).length === 0) delete result.mcp;
  return { table: result, problems: [], warnings: [] };
}

/**
 * The routes of the runtime: one for each passthrough target of its Box gateway, in the order of
 * the gateway's targets once build writes them. Build keeps each target it does not manage where
 * it is, keeps each `egress-` target that a host takes, removes the other `egress-` targets, and
 * adds the target of each other host at the end. Throws for two targets for one host, which would
 * give the box two routes to that host.
 */
function gatewayRoutes(context: RuntimeProfileContext): GatewayRoute[] {
  const managed = (name: string) => name.startsWith(BOX_EGRESS_TARGET_PREFIX);
  const served = context.hosts.filter(
    (host): host is BoxNetworkHost & { readonly target: string } =>
      host.target !== undefined && managed(host.target),
  );
  const targets: AgentCoreGatewayTarget[] = [];
  for (const target of context.gateway.targets) {
    if (!managed(target.name)) {
      targets.push(target);
      continue;
    }
    const host = served.find((candidate) => candidate.target === target.name);
    if (host) targets.push(gatewayTargetFor(host));
  }
  for (const host of served) {
    if (!targets.some(({ name }) => name === host.target)) targets.push(gatewayTargetFor(host));
  }

  const passthrough = targets.filter(
    (target) => target.targetType === "passthrough" && target.passthrough,
  );
  const hostOf = (target: AgentCoreGatewayTarget) => new URL(target.passthrough!.endpoint).host;
  const byHost = new Map<string, string>();
  for (const target of passthrough) {
    const other = byHost.get(hostOf(target));
    if (other !== undefined) {
      throw new InputValidationError(
        `gateway '${context.gateway.name}' has two passthrough targets for ${hostOf(target)}, ` +
          `'${other}' and '${target.name}', so runtime '${context.runtime.name}' would get two ` +
          "routes to one host. Remove one of them.",
      );
    }
    byHost.set(hostOf(target), target.name);
  }
  return passthrough.map((target) => {
    const server = context.hosts
      .filter((host) => host.target === target.name)
      .map(mcpSourceOf)
      .find((source) => source !== undefined);
    return { target: target.name, host: hostOf(target), ...(server && { server }) };
  });
}

/** The routes of `hosts`, in the order of the hosts; a host with no route has none. */
function routesOf(
  hosts: readonly BoxNetworkHost[],
  routes: readonly GatewayRoute[],
): GatewayRoute[] {
  return hosts.flatMap((host) => routes.filter((route) => route.target === host.target));
}

function mcpSourceOf(host: BoxNetworkHost): McpSource | undefined {
  return host.sources.find((source): source is McpSource => source.kind === "mcp");
}

/** Whether `entry` is an HTTP MCP server: it has no `command`, and it is `http` or names a host. */
function isHttpServer(entry: Readonly<TomlTable>): boolean {
  if ("command" in entry || entry.type === "stdio") return false;
  return entry.type === "http" || "url" in entry || "destinations" in entry;
}

/**
 * The `[egress.<target>]` route of `route`, with each key of `entry` that the gateway form does not
 * set. Its secret goes: the gateway target sends the credential.
 */
function egressRoute(entry: Readonly<TomlTable>, route: GatewayRoute, region: string): TomlTable {
  const { destinations: _destinations, secret: _secret, backends: _backends, ...kept } = entry;
  return { destinations: [route.host], ...kept, backends: [gatewayBackend(route, region)] };
}

/**
 * The HTTP `[mcp.<name>]` server of `route`, with each key of `entry` that the gateway form does not
 * set. The server keeps its name, so the box still decides each `mcp:call`. An `env://` secret of
 * the server, as Box resolves it, stays without `inject`: the agent keeps its stand-in, and the
 * gateway sends the key. Box refuses a signed secret beside a backend, so that one goes.
 */
function mcpServer(
  entry: Readonly<TomlTable>,
  route: GatewayRoute,
  server: McpSource,
  region: string,
): TomlTable {
  const {
    type: _type,
    destinations: _destinations,
    secret: _secret,
    backends: _backends,
    ...kept
  } = entry;
  const secret = server.secret?.ref.startsWith("env://")
    ? Object.fromEntries(
        Object.entries(server.secret).filter(
          ([field, value]) => field !== "inject" && value !== undefined,
        ),
      )
    : undefined;
  return {
    type: "http",
    destinations: [route.host],
    ...(secret && { secret }),
    ...kept,
    backends: [gatewayBackend(route, region)],
  };
}

/** The backend of a route: the route's gateway target, signed for the gateway in `region`. */
function gatewayBackend(route: GatewayRoute, region: string): TomlTable {
  return {
    url: `${RUNTIME_INPUTS.gatewayUrl}/${route.target}`,
    auth: { ref: RUNTIME_AWS_SIGNER, aws: { service: "bedrock-agentcore", region } },
  };
}
