/**
 * The Box network model of one box runtime: the box profile parsed and evaluated once, with each
 * host's outbound auth and gateway target, the `env://` routes its targets need a credential for,
 * the policy files to stage, and every warning and failure. Build, deploy, and staging write from
 * it.
 */
import { BOX_GATEWAY_AGENTCORE_HOST } from "../../../handlers/project/shortcuts";
import type { AgentCoreGateway, AgentCoreGatewayTarget } from "../../../projectSchemas/gateway";
import type { ProjectSpec } from "../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { BOX_MEMORY_POLICY_FILE } from "../boxMemory";
import { boxEgressCredentialName } from "../boxProfileCredentials";
import type { BoxEnvRoute } from "../boxProfileEgress";
import { buildHostMap, entryLabel, entryRef, type MappedHost } from "./hostMap";
import { BOX_EGRESS_TARGET_PREFIX, outboundAuthFor, parseEndpoint, targetNameFor } from "./egress";
import { describeEntry, describeRule, ruleOrigin } from "./places";
import { placeOf, type ParsedPolicy } from "./policyParser";
import { outboundAuthWords, sameOutboundAuth, targetOutboundAuth } from "./projectSpec";
import {
  MAX_GATEWAY_TARGETS,
  hostKey,
  type BoxNetworkFailure,
  type ConversionFailure,
  type FailureCode,
} from "./types";
import type { SourceSpan } from "./dogwood";

export type { BoxNetworkFailure } from "./types";

/** Where a failure of a target in agentcore.json is. */
const PROJECT_SPEC_PLACE = "agentcore/agentcore.json";

/**
 * The routes of box/bedrock. The agent calls Bedrock directly with the execution role, as the
 * AgentCore Runtime profile's own `[egress.bedrock]` route does, so their hosts take no target.
 */
const DIRECT_BEDROCK_ROUTES: ReadonlySet<string> = new Set(["bedrock", "bedrock_control"]);

/** How the gateway authenticates its requests to a host. */
export type BoxEgressAuth =
  | { readonly kind: "none" }
  | { readonly kind: "iam"; readonly service: string; readonly region: string }
  | {
      readonly kind: "apiKey";
      readonly credentialName: string;
      /** The variable Box reads the key from locally (`env://<variable>`). */
      readonly variable: string;
      readonly header: string;
      readonly prefix?: string;
    };

/** What names a host: an `[egress]` entry with its destinations there, or a permit. */
export type BoxNetworkSource =
  | {
      readonly kind: "entry";
      readonly egressEntry: string;
      readonly destinations: readonly string[];
    }
  | { readonly kind: "rule"; readonly ruleId: string };

/** One host of the box profile, and how Box decides it. */
export interface BoxNetworkHost {
  readonly host: string;
  /** Absent for 443. */
  readonly port?: number;
  /** `host`, or `host:port` for a port other than 443. */
  readonly authority: string;
  readonly sources: readonly BoxNetworkSource[];
  readonly outboundAuth: BoxEgressAuth;
  /** Whether Box allows at least one request to the host. */
  readonly reachable: boolean;
  /** The gateway target that serves a reachable host. */
  readonly target?: string;
  /** How many of the sample requests the analysis evaluated Box allows. */
  readonly allowed: number;
  readonly samples: number;
  /** The forbids that deny a request a permit allows, by `@id`. */
  readonly forbiddenBy: readonly string[];
  /** The rules that limit what Box allows to the host, which Box enforces and the gateway does not. */
  readonly enforcedByBox: readonly string[];
}

/** The Box network model of one box runtime. */
export interface BoxNetwork {
  readonly runtime: string;
  /** The runtime's Box gateway, as agentcore.json names it. */
  readonly gateway: string;
  /** The `[egress]` entries' hosts in profile order, then the hosts only the permits name. */
  readonly hosts: readonly BoxNetworkHost[];
  /** The `env://` route of each target that sends an API key, for the credentials writer. */
  readonly envRoutes: readonly BoxEnvRoute[];
  /** The policy files, relative to `.box/`, to copy beside the AgentCore Runtime profile. */
  readonly policyFiles: readonly string[];
  /** The IAM actions that the gateway's `additionalPolicies` files grant its role. */
  readonly grantedActions: readonly string[];
  readonly warnings: readonly string[];
  readonly failures: readonly BoxNetworkFailure[];
}

/** What the model needs of the project besides the parsed profile and policy. */
export interface BoxNetworkProject {
  readonly spec: ProjectSpec;
  readonly runtime: ProjectRuntime;
  /** The runtime's Box gateway, as agentcore.json names it. */
  readonly gateway: string;
  /** The gateway's targets, with the `agentcore` target that build adds for the Memory calls. */
  readonly targets: readonly AgentCoreGatewayTarget[];
  /** The IAM actions that the gateway's `additionalPolicies` files grant. */
  readonly grantedActions: readonly string[];
}

/** The Box gateway of `runtime`: the gateway bound to it. */
export function boxGatewayOf(spec: ProjectSpec, runtime: string): AgentCoreGateway | undefined {
  return spec.agentCoreGateways.find(({ boundRuntime }) => boundRuntime === runtime);
}

/**
 * Builds the model of one box runtime from what the profile and policy parsers parsed, after the
 * failures they found. It evaluates the policy on each host while it builds the model.
 */
export function buildBoxNetwork(
  parsed: ParsedPolicy,
  parseFailures: readonly BoxNetworkFailure[],
  project: BoxNetworkProject,
): BoxNetwork {
  const map = buildHostMap({
    statements: parsed.statements,
    egress: parsed.profile.egress,
    mcp: parsed.profile.mcp,
  });
  const located = (failure: ConversionFailure): BoxNetworkFailure => {
    const { span, firstSpan, reason, ...rest } = failure;
    if (failure.code === "DUPLICATE_RULE_ID" && span && firstSpan) {
      return { ...rest, ...duplicateRule(parsed, failure.ruleId!, firstSpan, span) };
    }
    const where =
      failure.ruleId !== undefined
        ? describeRule(parsed, failure.ruleId, span)
        : failure.egressEntry !== undefined
          ? describeEntry(parsed, "egress", failure.egressEntry)
          : failure.mcpEntry !== undefined
            ? describeEntry(parsed, "mcp", failure.mcpEntry)
            : undefined;
    if (!where) return { ...rest, reason, place: parsed.profile.path };
    return { ...rest, reason: `${where.subject} ${reason}`, place: where.place };
  };
  const failures: BoxNetworkFailure[] = [...parseFailures, ...map.failures.map(located)];
  const mcpHosts = map.hosts.filter(({ entry }) => entry?.table === "mcp");
  const routed = map.hosts.filter(
    ({ entry }) =>
      entry?.table !== "mcp" &&
      !(entry?.table === "egress" && DIRECT_BEDROCK_ROUTES.has(entry.name)),
  );
  const targets = hostTargets(routed, project, located, parsed.profile.path);
  failures.push(...targets.failures);
  return {
    runtime: project.runtime.name,
    gateway: project.gateway,
    hosts: targets.hosts,
    envRoutes: envRoutesOf(targets.hosts),
    policyFiles: parsed.profile.policyFiles,
    grantedActions: project.grantedActions,
    warnings: [
      ...hostWarnings(targets.hosts),
      ...mcpHosts.map(
        (host) =>
          `${host.authority}: build does not send an HTTP MCP server through the Box gateway yet, ` +
          `so ${entryLabel(host.entry!)} gets no gateway target, and the agent cannot reach it ` +
          "on AgentCore Runtime.",
      ),
      ...map.websocketOnly.map(({ ruleId, span }) => {
        const { place, subject } = describeRule(parsed, ruleId, span);
        return (
          `${place}: ${subject} allows only WebSocket connections, and build adds no gateway ` +
          "target for a WebSocket, so it skips this rule."
        );
      }),
    ],
    failures,
  };
}

/** The `env://` route of each host whose target sends an API key, once for each route. */
function envRoutesOf(hosts: readonly BoxNetworkHost[]): BoxEnvRoute[] {
  const routes: BoxEnvRoute[] = [];
  for (const { target, outboundAuth, sources } of hosts) {
    const entry = sources.find((source) => source.kind === "entry");
    if (target === undefined || outboundAuth.kind !== "apiKey" || entry?.kind !== "entry") continue;
    if (routes.some(({ route }) => route === entry.egressEntry)) continue;
    routes.push({ route: entry.egressEntry, variable: outboundAuth.variable });
  }
  return routes;
}

/** Whether build manages `target`: it adds, changes, and removes each target with the prefix. */
export function isManagedTarget(target: Pick<AgentCoreGatewayTarget, "name">): boolean {
  return target.name.startsWith(BOX_EGRESS_TARGET_PREFIX);
}

/** The host map key of a passthrough target's endpoint, or `undefined` for another target. */
function endpointKey(target: AgentCoreGatewayTarget): string | undefined {
  const at = target.passthrough && parseEndpoint(target.passthrough.endpoint);
  return at ? hostKey(at.host, at.port) : undefined;
}

/**
 * The failure of a rule whose `@id` an earlier rule has, at the user's own copy: two of the user's
 * rules name each other, and a copy of a rule Box adds names the part of the profile that makes
 * Box add it.
 */
function duplicateRule(
  parsed: ParsedPolicy,
  ruleId: string,
  first: SourceSpan,
  later: SourceSpan,
): Pick<BoxNetworkFailure, "reason" | "place"> {
  const earlier = placeOf(parsed, first);
  const copy = placeOf(parsed, later);
  const rule = `The rule ${JSON.stringify(ruleId)}`;
  if (earlier !== undefined && copy !== undefined) {
    return {
      place: copy,
      reason: `${rule} has the same @id as the rule at ${earlier}. Give each rule its own @id.`,
    };
  }
  const own = copy ?? earlier;
  const origin = ruleOrigin(parsed, ruleId);
  if (own === undefined) {
    return {
      place: origin.place,
      reason: `Box and its packs add two rules with the @id ${JSON.stringify(ruleId)}. Remove one of the packs in \`packs\` that add it.`,
    };
  }
  const file = own.replace(/:\d+(?::\d+)?$/, "");
  return {
    place: own,
    reason:
      origin.by === "box"
        ? `${rule} is one Box adds itself ${origin.purpose}. Remove it from ${file}.`
        : `${rule} has the same @id as a rule that a pack in \`packs\` adds. Give your rule another @id.`,
  };
}

/**
 * Each host's outbound auth, and the gateway target of each reachable host: the target the
 * gateway holds for its host and port, whatever its name, or a new `egress-` name.
 */
function hostTargets(
  mapped: readonly MappedHost[],
  project: BoxNetworkProject,
  located: (failure: ConversionFailure) => BoxNetworkFailure,
  profilePath: string,
): { hosts: BoxNetworkHost[]; failures: BoxNetworkFailure[] } {
  const existing = project.targets;
  const failures: BoxNetworkFailure[] = [];
  for (const target of existing) {
    const changed = isManagedTarget(target) ? unmanagedShape(target) : undefined;
    if (changed === undefined) continue;
    failures.push({
      code: "MANAGED_TARGET_CHANGED",
      target: target.name,
      reason:
        `The gateway target '${target.name}' ${changed}, which build does not write for a ` +
        `target whose name starts with "${BOX_EGRESS_TARGET_PREFIX}", so build does not change ` +
        `or remove it. Rename it without "${BOX_EGRESS_TARGET_PREFIX}" to keep it as yours, or ` +
        "remove it so build writes it again.",
      place: PROJECT_SPEC_PLACE,
    });
  }
  /** The entry, or else the first rule, that names the host. */
  const namer = (
    host: MappedHost,
  ): Pick<ConversionFailure, "egressEntry" | "mcpEntry" | "ruleId"> =>
    host.entry
      ? entryRef(host.entry)
      : host.namedBy[0] !== undefined
        ? { ruleId: host.namedBy[0] }
        : {};
  /** A failure of the host's entry or rule; `reason` follows the entry's or the rule's name. */
  const failAt = (host: MappedHost, code: FailureCode, reason: string) => {
    failures.push(located({ code, ...namer(host), reason }));
  };

  const claimed = new Set<string>();
  const reused = new Set<number>();
  /** The variable and the entry of each API key credential an entry takes. */
  const keys = new Map<string, { readonly variable: string; readonly entry: string }>();
  const hosts = mapped.map((host, index): BoxNetworkHost => {
    let auth: BoxEgressAuth = { kind: "none" };
    const entry = host.entry;
    if (entry) {
      const result = outboundAuthFor(entry.secret, host.host, (variable) =>
        boxEgressCredentialName(project.spec.credentials, entry.name, variable),
      );
      if (result.ok) auth = result.auth;
      else failAt(host, result.code, result.reason);
      const holder = auth.kind === "apiKey" ? keys.get(auth.credentialName) : undefined;
      if (auth.kind === "apiKey" && holder && holder.variable !== auth.variable) {
        failAt(
          host,
          "API_KEY_CREDENTIAL_SHARED",
          `needs the API key credential '${auth.credentialName}' for env://${auth.variable}, ` +
            `and ${holder.entry} takes that credential for env://${holder.variable}. One ` +
            "credential holds one key. Rename the entry.",
        );
      } else if (auth.kind === "apiKey" && !holder) {
        keys.set(auth.credentialName, { variable: auth.variable, entry: entryLabel(entry) });
      }
    }
    let target: string | undefined;
    if (host.reachable) {
      const held = existing.find(
        (candidate) => !claimed.has(candidate.name) && endpointKey(candidate) === host.authority,
      );
      if (held) {
        claimed.add(held.name);
        reused.add(index);
        const conflict = isManagedTarget(held)
          ? undefined
          : targetConflict(held, host, auth, profilePath);
        if (conflict) {
          failures.push({
            code: "EXISTING_TARGET_CONFLICT",
            ...namer(host),
            target: held.name,
            reason: conflict,
            place: PROJECT_SPEC_PLACE,
          });
        }
        target = held.name;
      } else {
        const proposed = entry
          ? entry.split
            ? `${entry.name}-${host.authority}`
            : entry.name
          : host.authority;
        target = targetNameFor(proposed);
        if (target === undefined) {
          failAt(
            host,
            "TARGET_NAME_INVALID",
            entry
              ? "has no letter or digit in its name, so build cannot name a gateway target after " +
                  "it. Rename the entry."
              : `allows ${host.authority}, which has no letter or digit to name a gateway ` +
                  `target after. Add an [egress] entry with a name for ${host.authority}.`,
          );
        }
      }
    }
    return {
      host: host.host,
      ...(host.port !== 443 && { port: host.port }),
      authority: host.authority,
      sources: [
        ...(entry
          ? [{ kind: "entry" as const, egressEntry: entry.name, destinations: entry.destinations }]
          : []),
        ...host.namedBy.map((ruleId) => ({ kind: "rule" as const, ruleId })),
      ],
      outboundAuth: auth,
      reachable: host.reachable,
      ...(target !== undefined && { target }),
      allowed: host.decision.allowed.length,
      samples: host.decision.samples,
      forbiddenBy: host.forbiddenBy,
      enforcedByBox: host.enforcedByBox,
    };
  });

  // A target that build does not manage keeps its name, and two hosts take no one name.
  const owners = new Map<string, string>();
  for (const target of existing) {
    if (!isManagedTarget(target)) owners.set(target.name, `the gateway target '${target.name}'`);
  }
  const describeHost = (host: MappedHost) =>
    host.entry ? `${entryLabel(host.entry)} for ${host.authority}` : `the host ${host.authority}`;
  for (const index of reused) owners.set(hosts[index]!.target!, describeHost(mapped[index]!));
  mapped.forEach((host, index) => {
    const name = hosts[index]!.target;
    if (name === undefined || reused.has(index)) return;
    const owner = owners.get(name);
    if (owner !== undefined) {
      failAt(
        host,
        "TARGET_NAME_COLLISION",
        host.entry
          ? `would name the gateway target for ${host.authority} '${name}', and ${owner} has ` +
              "that name. Rename the entry."
          : `allows ${host.authority}, and its gateway target would have the name '${name}', ` +
              `which ${owner} has. Add an [egress] entry with another name for ${host.authority}.`,
      );
      return;
    }
    owners.set(name, describeHost(host));
  });

  const served = hosts.filter((host) => host.target !== undefined).length;
  const kept = existing.filter((target) => !isManagedTarget(target) && !claimed.has(target.name));
  if (served + kept.length > MAX_GATEWAY_TARGETS) {
    failures.push({
      code: "TOO_MANY_TARGETS",
      reason:
        `The gateway '${project.gateway}' needs ${served + kept.length} targets, ${served} for ` +
        `the hosts of the Box profile and ${kept.length} of your own, and a gateway can have at ` +
        `most ${MAX_GATEWAY_TARGETS}. Remove hosts from the profile, or targets from the gateway.`,
      place: profilePath,
    });
  }
  return { hosts, failures };
}

/**
 * What of `target` build does not write, to follow the target's name (`has protocolType MCP`), or
 * `undefined` when build could have written it.
 */
function unmanagedShape(target: AgentCoreGatewayTarget): string | undefined {
  const extra = Object.keys(target).filter(
    (key) => !["name", "targetType", "passthrough", "outboundAuth"].includes(key),
  );
  if (target.targetType !== "passthrough" || !target.passthrough)
    return `has targetType ${target.targetType}`;
  if (extra.length > 0) return `has the field ${extra.join(", ")}`;
  const { endpoint, protocolType, stickinessConfiguration } = target.passthrough;
  if (protocolType !== "CUSTOM") return `has protocolType ${protocolType}`;
  if (stickinessConfiguration) return "has a stickinessConfiguration";
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(endpoint)) return `has the endpoint ${endpoint}`;
  const auth = target.outboundAuth;
  const fields = auth ? Object.keys(auth).sort().join(",") : "";
  const shapes: Record<string, string[]> = {
    NONE: ["type"],
    GATEWAY_IAM_ROLE: ["region,service,type"],
    API_KEY: [
      "credentialName,location,parameterName,type",
      "credentialName,location,parameterName,prefix,type",
    ],
  };
  if (!auth) return undefined;
  const allowed = shapes[auth.type];
  if (!allowed?.includes(fields) || (auth.type === "API_KEY" && auth.location !== "HEADER")) {
    return `sends ${outboundAuthWords(auth)}`;
  }
  return undefined;
}

/** Why a host cannot take a target build does not manage, or `undefined` when it can. */
function targetConflict(
  target: AgentCoreGatewayTarget,
  host: MappedHost,
  auth: BoxEgressAuth,
  profilePath: string,
): string | undefined {
  const endpoint = target.passthrough && parseEndpoint(target.passthrough.endpoint);
  const named = `The gateway target '${target.name}' for ${host.authority}`;
  if (target.passthrough?.protocolType !== "CUSTOM") {
    return (
      `${named} has protocolType ${target.passthrough?.protocolType}, and Box needs CUSTOM. ` +
      "Set its protocolType to CUSTOM, or remove the target."
    );
  }
  if (endpoint && endpoint.path !== "") {
    return (
      `${named} has the path ${endpoint.path} in its endpoint, and the agent's requests do not ` +
      `include it. Remove ${endpoint.path} from the endpoint, or remove the target.`
    );
  }
  // A host that no entry names has no secret, so the target's own outbound auth stands.
  if (!host.entry) return undefined;
  const wanted = targetOutboundAuth(auth);
  if (sameOutboundAuth(target.outboundAuth, wanted)) return undefined;
  return (
    `${named} sends ${outboundAuthWords(target.outboundAuth)}, and ` +
    `${entryLabel(host.entry)} sends ${outboundAuthWords(wanted)}. Make the two the ` +
    `same, in agentcore.json or in ${profilePath}.`
  );
}

/** A warning for each host whose limits Box enforces alone, and each entry host with no target. */
function hostWarnings(hosts: readonly BoxNetworkHost[]): string[] {
  const warnings: string[] = [];
  const rules = (ids: readonly string[]) => {
    const quoted = ids.map((id) => JSON.stringify(id));
    const list =
      quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}` : quoted[0];
    return `the ${quoted.length > 1 ? "rules" : "rule"} ${list}`;
  };
  for (const host of hosts) {
    const entry = host.sources.find((source) => source.kind === "entry");
    if (!host.reachable) {
      if (entry?.kind !== "entry") continue;
      const deny =
        host.forbiddenBy.length === 0
          ? ""
          : ` (${rules(host.forbiddenBy)} ${host.forbiddenBy.length > 1 ? "deny" : "denies"} it)`;
      warnings.push(
        `${host.authority}: your policy allows no request to this host${deny}, so ` +
          `[egress.${entry.egressEntry}] gets no gateway target.`,
      );
      continue;
    }
    if (host.enforcedByBox.length === 0) continue;
    warnings.push(
      `${host.authority}: the gateway allows every request to this host; Box still applies ` +
        `${rules(host.enforcedByBox)}.` +
        (entry
          ? ""
          : " On AgentCore Runtime, Box applies only your forbid rules to this host, so write " +
            "each limit as a forbid rule to keep it there."),
    );
  }
  return warnings;
}

/**
 * A warning for each target of the network's Box gateway in `spec`, as build writes it, that the
 * gateway signs with its own role for a service that no policy of that role grants. The Memory
 * policy file that build writes grants the Memory calls; a gateway that imports its role is the
 * user's to grant.
 */
export function boxGatewayIamWarnings(
  spec: ProjectSpec,
  network: Pick<BoxNetwork, "runtime" | "gateway" | "grantedActions">,
): string[] {
  const gateway = boxGatewayOf(spec, network.runtime);
  if (!gateway || gateway.executionRoleArn) return [];
  const memoryGranted = (gateway.additionalPolicies ?? []).includes(BOX_MEMORY_POLICY_FILE);
  const granted = (service: string) =>
    network.grantedActions.some(
      (action) => action === "*" || action.toLowerCase().startsWith(`${service}:`),
    );
  const warnings: string[] = [];
  for (const target of gateway.targets) {
    const auth = target.outboundAuth;
    if (auth?.type !== "GATEWAY_IAM_ROLE" || !auth.service || granted(auth.service)) continue;
    const memory =
      auth.service === "bedrock-agentcore" && endpointKey(target) === BOX_GATEWAY_AGENTCORE_HOST;
    if (memory && memoryGranted) continue;
    warnings.push(
      `Target '${target.name}' calls ${auth.service} with the gateway's role, which has no ` +
        `${auth.service} permissions. Add an IAM policy file to additionalPolicies of the ` +
        `'${network.gateway}' gateway.`,
    );
  }
  return warnings;
}
