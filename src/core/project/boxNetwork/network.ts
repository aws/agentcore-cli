/**
 * The Box network model of one box runtime: the box profile parsed and evaluated once, with each
 * host's outbound auth and gateway target, the credentials it needs, the policy files to stage,
 * and every warning and failure. Build, deploy, and staging write from it.
 */
import {
  BOX_GATEWAY_AGENTCORE_HOST,
  BOX_GATEWAY_BEDROCK_TARGET_NAME,
} from "../../../handlers/project/shortcuts";
import type { AgentCoreGatewayTarget } from "../../../projectSchemas/gateway";
import type { ProjectSpec } from "../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { BOX_BEDROCK_POLICY_FILE, BOX_MEMORY_POLICY_FILE } from "../boxMemory";
import { boxEgressCredentialName, boxEgressCredentials } from "../boxProfileCredentials";
import { buildHostMap, type MappedHost } from "./hostMap";
import { BOX_EGRESS_TARGET_PREFIX, outboundAuthFor, parseEndpoint, targetNameFor } from "./egress";
import { placeOf, type ParsedPolicy } from "./policyParser";
import { outboundAuthText, sameOutboundAuth, targetOutboundAuth } from "./projectSpec";
import { MAX_GATEWAY_TARGETS, hostKey, type ConversionFailure, type FailureCode } from "./types";

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

/** An API key credential that an `env://` entry needs, and the variable that holds its key. */
export interface BoxEgressCredential {
  readonly name: string;
  readonly variable: string;
}

/** Why the model cannot be written, and where. */
export interface BoxNetworkFailure {
  readonly code: FailureCode;
  readonly ruleId?: string;
  readonly egressEntry?: string;
  readonly mcpEntry?: string;
  readonly target?: string;
  readonly reason: string;
  /** `file:line:column`, `file:line`, or `a rule the box CLI adds`. */
  readonly place?: string;
}

/** The Box network model of one box runtime. */
export interface BoxNetwork {
  readonly runtime: string;
  /** The runtime's Box gateway, as agentcore.json names it. */
  readonly gateway: string;
  /** The `[egress]` entries' hosts in profile order, then the hosts only the permits name. */
  readonly hosts: readonly BoxNetworkHost[];
  readonly credentials: readonly BoxEgressCredential[];
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
  /**
   * The gateway's targets, with the `bedrock` and `agentcore` targets that build adds for the
   * runtime's model and Memory calls (`addBoxGatewayTargets`).
   */
  readonly targets: readonly AgentCoreGatewayTarget[];
  /** The IAM actions that the gateway's `additionalPolicies` files grant. */
  readonly grantedActions: readonly string[];
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
    const { span, ...rest } = failure;
    return span ? { ...rest, place: placeOf(parsed.segments, span) } : rest;
  };
  const failures: BoxNetworkFailure[] = [...parseFailures, ...map.failures.map(located)];
  const targets = hostTargets(map.hosts, project, (ruleId) => {
    const statement = parsed.statements.find(({ id }) => id === ruleId);
    return statement && placeOf(parsed.segments, statement.span);
  });
  failures.push(...targets.failures);
  const credentials = boxEgressCredentials(parsed.profile.egress, project.spec.credentials);
  return {
    runtime: project.runtime.name,
    gateway: project.gateway,
    hosts: targets.hosts,
    credentials: credentials.needed,
    policyFiles: parsed.profile.policyFiles,
    grantedActions: project.grantedActions,
    warnings: [...credentials.skipped, ...hostWarnings(targets.hosts, project.gateway)],
    failures,
  };
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
 * Each host's outbound auth, and the gateway target of each reachable host: the target the
 * gateway holds for its host and port, whatever its name, or a new `egress-` name.
 */
function hostTargets(
  mapped: readonly MappedHost[],
  project: BoxNetworkProject,
  placeOfRule: (ruleId: string) => string | undefined,
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
        `the Box gateway's target ${target.name} has ${changed}, which build does not write, so ` +
        "build neither changes nor removes it. Rename it to keep it as yours, or remove it from " +
        "agentcore.json so build writes it again",
      place: "agentcore/agentcore.json",
    });
  }
  const failAt = (host: MappedHost, code: FailureCode, reason: string) => {
    if (host.entry) {
      const egressEntry = host.entry.egressEntry;
      failures.push({ code, egressEntry, reason: `[egress.${egressEntry}]: ${reason}` });
      return;
    }
    const ruleId = host.namedBy[0];
    const place = ruleId === undefined ? undefined : placeOfRule(ruleId);
    failures.push({
      code,
      reason,
      ...(ruleId !== undefined && { ruleId }),
      ...(place !== undefined && { place }),
    });
  };

  const claimed = new Set<string>();
  const reused = new Set<number>();
  const hosts = mapped.map((host, index): BoxNetworkHost => {
    let auth: BoxEgressAuth = { kind: "none" };
    const entry = host.entry;
    if (entry) {
      const result = outboundAuthFor(entry.secret, host.host, (variable) =>
        boxEgressCredentialName(project.spec.credentials, entry.egressEntry, variable),
      );
      if (result.ok) auth = result.auth;
      else failAt(host, result.code, result.reason);
    }
    let target: string | undefined;
    if (host.reachable) {
      const held = existing.find(
        (candidate) => !claimed.has(candidate.name) && endpointKey(candidate) === host.authority,
      );
      if (held) {
        claimed.add(held.name);
        reused.add(index);
        const conflict = isManagedTarget(held) ? undefined : targetConflict(held, host, auth);
        if (conflict) failAt(host, "EXISTING_TARGET_CONFLICT", conflict);
        target = held.name;
      } else {
        const proposed = entry
          ? entry.split
            ? `${entry.egressEntry}-${host.authority}`
            : entry.egressEntry
          : host.authority;
        target = targetNameFor(proposed);
        if (target === undefined) {
          const from = entry ? "its name" : `${host.authority}, which only the policy names,`;
          failAt(
            host,
            "TARGET_NAME_INVALID",
            `${from} has no letter or digit to name a gateway target`,
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
          ? [
              {
                kind: "entry" as const,
                egressEntry: entry.egressEntry,
                destinations: entry.destinations,
              },
            ]
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
    if (!isManagedTarget(target))
      owners.set(target.name, `the Box gateway's target ${target.name}`);
  }
  const describeHost = (host: MappedHost) =>
    host.entry ? `[egress.${host.entry.egressEntry}] for ${host.authority}` : host.authority;
  for (const index of reused) owners.set(hosts[index]!.target!, describeHost(mapped[index]!));
  mapped.forEach((host, index) => {
    const name = hosts[index]!.target;
    if (name === undefined || reused.has(index)) return;
    const owner = owners.get(name);
    if (owner !== undefined) {
      failAt(
        host,
        "TARGET_NAME_COLLISION",
        `the target name ${name} for ${host.authority} is taken by ${owner}; ` +
          (host.entry
            ? "rename the [egress] entry"
            : `give ${host.host} an [egress] entry with another name`),
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
      reason: `the Box gateway ${project.gateway} needs ${served + kept.length} targets (${served} for the hosts of the profile, ${kept.length} that it keeps); one gateway holds ${MAX_GATEWAY_TARGETS}`,
    });
  }
  return { hosts, failures };
}

/** What of `target` build does not write, or `undefined` when build could have written it. */
function unmanagedShape(target: AgentCoreGatewayTarget): string | undefined {
  const extra = Object.keys(target).filter(
    (key) => !["name", "targetType", "passthrough", "outboundAuth"].includes(key),
  );
  if (target.targetType !== "passthrough" || !target.passthrough)
    return `type ${target.targetType}`;
  if (extra.length > 0) return `the field ${extra.join(", ")}`;
  const { endpoint, protocolType, stickinessConfiguration } = target.passthrough;
  if (protocolType !== "CUSTOM") return `protocolType ${protocolType}`;
  if (stickinessConfiguration) return "a stickinessConfiguration";
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(endpoint)) return `the endpoint ${endpoint}`;
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
    return `the outbound auth ${outboundAuthText(auth)}`;
  }
  return undefined;
}

/** Why a host cannot take a target build does not manage, or `undefined` when it can. */
function targetConflict(
  target: AgentCoreGatewayTarget,
  host: MappedHost,
  auth: BoxEgressAuth,
): string | undefined {
  const endpoint = target.passthrough && parseEndpoint(target.passthrough.endpoint);
  if (target.passthrough?.protocolType !== "CUSTOM") {
    return `the Box gateway's target ${target.name} serves ${host.authority} as a ${target.passthrough?.protocolType} passthrough target, and a box route needs CUSTOM. Change its protocolType in agentcore.json, or remove it`;
  }
  if (endpoint && endpoint.path !== "") {
    return `the Box gateway's target ${target.name} sends the requests for ${host.authority} under the path ${endpoint.path}, which the agent's requests do not name. Remove the path from its endpoint in agentcore.json, or remove the target`;
  }
  // A host that no entry names has no secret, so the target's own outbound auth stands.
  if (!host.entry) return undefined;
  const wanted = targetOutboundAuth(auth);
  if (sameOutboundAuth(target.outboundAuth, wanted)) return undefined;
  return `the Box gateway's target ${target.name} sends ${outboundAuthText(target.outboundAuth)} to ${host.authority}, and [egress.${host.entry.egressEntry}] gives it ${outboundAuthText(wanted)}; one host has one target. Make the two the same, in agentcore.json or in .box/profile.toml`;
}

/** A warning for each host whose limits Box enforces alone, and each entry host with no target. */
function hostWarnings(hosts: readonly BoxNetworkHost[], gateway: string): string[] {
  const warnings: string[] = [];
  const list = (rules: readonly string[]) => rules.map((rule) => `"${rule}"`).join(", ");
  for (const host of hosts) {
    const entry = host.sources.find((source) => source.kind === "entry");
    if (!host.reachable) {
      if (!entry) continue;
      warnings.push(
        `[egress.${entry.egressEntry}] ${host.authority} gets no target of gateway '${gateway}': ` +
          "Box allows no request to it" +
          (host.forbiddenBy.length > 0 ? `, and ${list(host.forbiddenBy)} forbid it` : ""),
      );
      continue;
    }
    if (host.enforcedByBox.length === 0) continue;
    warnings.push(
      `${host.authority} (target '${host.target}' of gateway '${gateway}'): the gateway forwards ` +
        `every request to it, and Box enforces ${list(host.enforcedByBox)} on its own; Box ` +
        `allows ${host.allowed} of ${host.samples} sample requests` +
        (entry
          ? ""
          : `. The AgentCore Runtime route for ${host.authority} permits every request to it, so ` +
            "there Box enforces the forbids, and not the method and path limits of the permits"),
    );
  }
  return warnings;
}

/**
 * A warning for each target of the network's Box gateway in `spec`, as build writes it, that the
 * gateway signs with its own role for a service that no policy of that role grants. The Bedrock
 * policy file that build writes grants `bedrock`, and the Memory policy file the Memory calls; a
 * gateway that imports its role is the user's to grant.
 */
export function boxGatewayIamWarnings(
  spec: ProjectSpec,
  network: Pick<BoxNetwork, "gateway" | "grantedActions">,
): string[] {
  const gateway = spec.agentCoreGateways.find(({ name }) => name === network.gateway);
  if (!gateway || gateway.executionRoleArn) return [];
  const listed = gateway.additionalPolicies ?? [];
  const memoryGranted = listed.includes(BOX_MEMORY_POLICY_FILE);
  // Listed is enough: grantedActions is read from disk before build first writes this file.
  const bedrockGranted = listed.includes(BOX_BEDROCK_POLICY_FILE);
  const granted = (service: string) =>
    (service === "bedrock" && bedrockGranted) ||
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
    const created =
      target.name === BOX_GATEWAY_BEDROCK_TARGET_NAME ? " (agentcore create added it)" : "";
    warnings.push(
      `target '${target.name}' of gateway '${network.gateway}'${created} signs its requests with ` +
        `the gateway's role for '${auth.service}', and no policy of that role grants a ` +
        `'${auth.service}:' action, so ${auth.service} refuses them. Add an IAM policy file to ` +
        `additionalPolicies of ${network.gateway}.`,
    );
  }
  return warnings;
}
