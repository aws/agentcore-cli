/**
 * Rule 2 of the derivation: on AgentCore Runtime, each call of the box goes through the runtime's
 * Box gateway. Each passthrough target of that gateway, as build writes the gateway, gets one
 * route: the box sends the calls to the target's host to `${{ inputs.gateway.url }}/<target>`, and
 * signs them for the gateway in the Runtime's own region, `${{ inputs.aws.region }}`, with a bare
 * `aws://`, the execution role. The gateway then calls the host with the target's own auth.
 *
 * | Local profile | Runtime profile |
 * | --- | --- |
 * | `[egress.<name>]`, its first host with a target | `[egress.<name>]`, the other keys kept, no `secret`, a backend to its target |
 * | `[egress.<name>]`, each other host with a target, or a name that a target of another host has | `[egress.<target>]`, the other keys kept, no `secret` |
 * | HTTP `[mcp.<name>]` | `[mcp.<name>]`, the other keys kept, only an `env://` secret |
 * | a target that no entry of the profile names | `[egress.<target>]`, or the `[mcp]` server it serves |
 * | an entry whose hosts the policy denies | removed; the Box network model warns for it |
 * | an entry with no host in the Box network model | removed; the model fails the entry, and build stops |
 * | a gateway of the project that the agent calls (projectGatewaysOf) | `[mcp.<gateway>]` to the host in `<prefix>_HOST`, a backend to its target |
 *
 * A stdio `[mcp.<name>]` stays as it is: the `refusals` and `paths` rules own it.
 */
import { InputValidationError } from "../../../../errors/errors";
import type { AgentCoreGatewayTarget } from "../../../../projectSchemas/gateway";
import type { BoxHostSource, BoxNetworkHost } from "../../boxNetwork";
import { BOX_EGRESS_TARGET_PREFIX } from "../../boxNetwork/egress";
import { projectGatewayInputs, type BoxProjectGateway } from "../../boxNetwork/projectGateways";
import { gatewayTargetFor } from "../../boxNetwork/projectSpec";
import { isHttpServer, isTable } from "../projectPaths";
import {
  RUNTIME_AWS_SIGNER,
  RUNTIME_INPUTS,
  type RuleResult,
  type RuntimeProfileContext,
  type RuntimeProfileProblem,
  type TomlTable,
} from "../types";

type McpSource = Extract<BoxHostSource, { kind: "mcp" }>;

/** One route of the Runtime profile: a passthrough target of the Box gateway and its host. */
interface GatewayRoute {
  readonly target: string;
  /** `host`, or `host:port`, of the target's endpoint. */
  readonly host: string;
  /** The HTTP MCP server of the Box network model that the target serves. */
  readonly server?: McpSource;
}

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
      egress[routeKey(route, routes, context)] = egressRoute(entry, route);
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
    mcp[name] = mcpServer(entry, route, route.server);
    written.add(route.target);
  }

  for (const route of routes) {
    if (written.has(route.target)) continue;
    if (route.server) {
      mcp[route.server.mcpEntry] = mcpServer({}, route, route.server);
    } else {
      egress[routeKey(route, routes, context)] = egressRoute({}, route);
    }
  }

  const problems: RuntimeProfileProblem[] = [];
  for (const gateway of context.projectGateways ?? []) {
    if (Object.hasOwn(mcp, gateway.name)) {
      problems.push({
        code: "RUNTIME_GATEWAY_SERVER_NAME_TAKEN",
        key: ["mcp", gateway.name],
        reason:
          `[mcp.${gateway.name}] has the name of the gateway '${gateway.name}' of this project. ` +
          `On AgentCore Runtime, build adds the server [mcp.${gateway.name}] so the agent can ` +
          "call that gateway. Rename your server.",
        place: context.placeOf(["mcp", gateway.name]),
      });
      continue;
    }
    mcp[gateway.name] = projectGatewayServer(gateway);
  }

  // Each table keeps its place when the profile has it, and comes last when it does not. An empty
  // table goes.
  const result: TomlTable = { ...table, egress, mcp };
  if (Object.keys(egress).length === 0) delete result.egress;
  if (Object.keys(mcp).length === 0) delete result.mcp;
  return { table: result, problems, warnings: [] };
}

/**
 * The HTTP `[mcp.<gateway>]` server for a gateway of the project: the host the CDK library sets in
 * `<prefix>_HOST`, through the Box gateway target that calls the gateway. Box permits each tool of
 * the server, and a forbid rule of the policy still applies.
 */
function projectGatewayServer(gateway: BoxProjectGateway): TomlTable {
  return {
    type: "http",
    destinations: [`\${{ inputs.${projectGatewayInputs(gateway).host} }}`],
    backends: [gatewayBackend({ target: gateway.target })],
  };
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

  // A target that names a gateway of the project has no host here: that gateway's server does.
  const passthrough = targets.filter(
    (target) => target.targetType === "passthrough" && target.passthrough?.endpoint !== undefined,
  );
  const hostOf = (target: AgentCoreGatewayTarget) => new URL(target.passthrough!.endpoint!).host;
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

/**
 * The key of the `[egress]` route of `route`: the name of its entry when the route serves the first
 * host of one entry, else the name of the target. A pack that the profile imports keeps its own
 * `[egress.<name>]` on the Runtime, and box merges it with the route of that name, as
 * `[egress.bedrock]` of @box/bedrock does. A route under another name would be a second route to
 * the host, which box refuses. A target of the same name for another host keeps its name.
 */
function routeKey(
  route: GatewayRoute,
  routes: readonly GatewayRoute[],
  context: RuntimeProfileContext,
): string {
  const entriesOf = (host: BoxNetworkHost) => [
    ...new Set(
      host.sources.flatMap((source) => (source.kind === "entry" ? [source.egressEntry] : [])),
    ),
  ];
  const served = context.hosts.filter((host) => host.target === route.target);
  const entries = [...new Set(served.flatMap(entriesOf))];
  if (entries.length !== 1) return route.target;
  const name = entries[0]!;
  // The first host of the entry: a pack's own entry of that name merges with it, and the profile's
  // destinations replace the pack's, so no host of the pack's entry keeps a second route.
  const first = context.hosts.find(
    (host) => host.target !== undefined && entriesOf(host).includes(name),
  );
  if (first?.target !== route.target) return route.target;
  if (name !== route.target && routes.some(({ target }) => target === name)) return route.target;
  return name;
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

/**
 * The `[egress.<target>]` route of `route`, with each key of `entry` that the gateway form does not
 * set. Its secret goes: the gateway target sends the credential.
 */
function egressRoute(entry: Readonly<TomlTable>, route: GatewayRoute): TomlTable {
  const { destinations: _destinations, secret: _secret, backends: _backends, ...kept } = entry;
  return { destinations: [route.host], ...kept, backends: [gatewayBackend(route)] };
}

/**
 * The HTTP `[mcp.<name>]` server of `route`, with each key of `entry` that the gateway form does not
 * set. The server keeps its name, so the box still decides each `mcp:call`. An `env://` secret of
 * the server, as Box resolves it, stays without `inject`: the agent keeps its stand-in, and the
 * gateway sends the key. Box refuses a signed secret beside a backend, so that one goes.
 */
function mcpServer(entry: Readonly<TomlTable>, route: GatewayRoute, server: McpSource): TomlTable {
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
    backends: [gatewayBackend(route)],
  };
}

/**
 * The backend of a route: the route's gateway target, signed for the gateway in the Runtime's own
 * region, which box reads from the `aws.region` input of the agentcore pack.
 */
function gatewayBackend(route: Pick<GatewayRoute, "target">): TomlTable {
  return {
    url: `${RUNTIME_INPUTS.gatewayUrl}/${route.target}`,
    auth: {
      ref: RUNTIME_AWS_SIGNER,
      aws: { service: "bedrock-agentcore", region: RUNTIME_INPUTS.awsRegion },
    },
  };
}
