/**
 * The Box network model of one box runtime: the box profile parsed and evaluated once, with each
 * host's outbound auth and gateway target, the credentials it needs, the policy files to stage,
 * and every warning and failure. Build, deploy, and staging write from it.
 */
import { boxGatewayAgentCoreHost } from "../../../handlers/project/shortcuts";
import type { AgentCoreGatewayTarget } from "../../../projectSchemas/gateway";
import {
  credentialEnvironmentVariableNames,
  credentialEnvVarName,
} from "../../../projectSchemas/credential";
import type { ProjectSpec } from "../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { BOX_BEDROCK_POLICY_FILE, BOX_MEMORY_POLICY_FILE } from "../boxMemory";
import { boxEgressCredentialName, boxEgressCredentials } from "../boxProfileCredentials";
import { BOX_SECRETS_MANAGER_ENV, boxTelemetrySecretVariable } from "../boxTelemetrySecrets";
import { buildHostMap, entryLabel, entryRef, type MappedHost } from "./hostMap";
import {
  BOX_EGRESS_TARGET_PREFIX,
  awsEndpoint,
  outboundAuthFor,
  parseEndpoint,
  targetNameFor,
  type AwsEndpointApi,
  type BoxEgressSecret,
} from "./egress";
import { describeEntry, describeRule, ruleOrigin } from "./places";
import { placeOf, type ParsedPolicy } from "./policyParser";
import type { ParsedProfile } from "./profileParser";
import type { CloudWatchTelemetry, ThirdPartyTelemetry } from "./telemetry";
import { outboundAuthWords, sameOutboundAuth, targetOutboundAuth } from "./projectSpec";
import { MAX_GATEWAY_TARGETS, hostKey, type ConversionFailure, type FailureCode } from "./types";
import type { SourceSpan } from "./dogwood";

/** Where a failure of a target in agentcore.json is. */
const PROJECT_SPEC_PLACE = "agentcore/agentcore.json";

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

/**
 * What names a host: an `[egress]` entry with its destinations there, an HTTP `[mcp]` server, or a
 * permit.
 */
export type BoxNetworkSource =
  | {
      readonly kind: "entry";
      readonly egressEntry: string;
      readonly destinations: readonly string[];
    }
  | {
      readonly kind: "mcp";
      readonly mcpEntry: string;
      readonly destinations: readonly string[];
      /** The server's own secret, which the AgentCore Runtime profile keeps for the agent. */
      readonly secret?: BoxEgressSecret;
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
  /** The problem and how to fix it, in whole sentences that name its rule, entry, or target. */
  readonly reason: string;
  /**
   * The user's own file, as `file:line:column` or the file alone: a rule Box adds is at the part
   * of the profile that makes Box add it.
   */
  readonly place?: string;
}

/** The Box network model of one box runtime. */
export interface BoxNetwork {
  readonly runtime: string;
  /** The runtime's Box gateway, as agentcore.json names it. */
  readonly gateway: string;
  /** The region build builds for: of the Box gateway, its `bedrock` and `agentcore` targets. */
  readonly region: string;
  /**
   * The `[egress]` entries' hosts in profile order, then the HTTP `[mcp]` servers' hosts, then the
   * hosts only the permits name.
   */
  readonly hosts: readonly BoxNetworkHost[];
  readonly credentials: readonly BoxEgressCredential[];
  /** The policy files, relative to the agent's local box folder, to copy beside the AgentCore Runtime profile. */
  readonly policyFiles: readonly string[];
  /** The CloudWatch targets of the profile's `[telemetry]`; absent means none. */
  readonly telemetry?: readonly CloudWatchTelemetry[];
  /**
   * The third-party targets of the profile's `[telemetry]` that the AgentCore Runtime profile
   * carries; absent means none.
   */
  readonly thirdPartyTelemetry?: readonly ThirdPartyTelemetry[];
  /**
   * The IAM actions that the gateway's `additionalPolicies` files grant its role, except the
   * policy files that build writes.
   */
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
  /** The region build builds for. */
  readonly region: string;
  /**
   * The gateway's targets, with the `bedrock` and `agentcore` targets that build adds for the
   * runtime's model and Memory calls (`addBoxGatewayTargets`).
   */
  readonly targets: readonly AgentCoreGatewayTarget[];
  /** The IAM actions that the gateway's `additionalPolicies` files grant, except build's own. */
  readonly grantedActions: readonly string[];
  /**
   * Whether the AgentCore Runtime profile reads third-party telemetry keys from AWS Secrets
   * Manager ({@link BOX_SECRETS_MANAGER_ENV}). Off, it carries no third-party target, as before.
   */
  readonly secretsManager?: boolean;
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
  const targets = hostTargets(map.hosts, project, located, parsed.profile.path);
  failures.push(...targets.failures);
  const credentials = boxEgressCredentials(
    parsed.profile.egress,
    project.spec.credentials,
    parsed.profile.mcp,
  );
  const thirdParty = runtimeTelemetry(parsed.profile, project, credentials.needed);
  return {
    runtime: project.runtime.name,
    gateway: project.gateway,
    region: project.region,
    hosts: targets.hosts,
    credentials: credentials.needed,
    policyFiles: parsed.profile.policyFiles,
    ...(parsed.profile.telemetry && { telemetry: parsed.profile.telemetry }),
    ...(thirdParty.targets.length > 0 && { thirdPartyTelemetry: thirdParty.targets }),
    grantedActions: project.grantedActions,
    warnings: [
      ...credentials.skipped,
      ...thirdParty.warnings,
      ...hostWarnings(targets.hosts),
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

/**
 * The third-party telemetry targets that the AgentCore Runtime profile carries, and a warning for
 * each one it leaves out. With {@link BoxNetworkProject.secretsManager} off it carries none, and
 * warns for each target with a key. A CodeZip runtime carries no target with a key, because its
 * Runtime has no AWS CLI for Box to read the key with. A target with a key is also left out when
 * the variable deploy reads its key from is a variable that a credential reads, or that another
 * target of the profile reads, so deploy never sends one key to the wrong destination.
 */
function runtimeTelemetry(
  profile: ParsedProfile,
  project: BoxNetworkProject,
  credentials: readonly BoxEgressCredential[],
): { targets: ThirdPartyTelemetry[]; warnings: string[] } {
  const leftOut = (name: string, reason: string) =>
    `${profile.path}: the AgentCore Runtime profile leaves out [telemetry.${name}]: ${reason}.`;
  const keyed = (profile.thirdPartyTelemetry ?? []).filter(({ secret }) => secret !== undefined);
  if (!project.secretsManager) {
    return {
      targets: [],
      warnings: keyed.map(({ name }) =>
        leftOut(
          name,
          "on AgentCore Runtime, Box reads its key from AWS Secrets Manager, and no Box release " +
            `for Linux can do that yet. To try a box build that can, set ${BOX_SECRETS_MANAGER_ENV}=1`,
        ),
      ),
    };
  }
  const warnings = (profile.leftOutTelemetry ?? []).map(({ name, reason }) =>
    leftOut(name, reason),
  );
  const taken = new Set([
    ...project.spec.credentials.flatMap(credentialEnvironmentVariableNames),
    ...credentials.map(({ name }) => credentialEnvVarName(name)),
  ]);
  const targets: ThirdPartyTelemetry[] = [];
  for (const target of profile.thirdPartyTelemetry ?? []) {
    if (target.secret !== undefined && project.runtime.build === "CodeZip") {
      warnings.push(
        leftOut(
          target.name,
          "Box reads its key on AgentCore Runtime with the AWS CLI, which a CodeZip runtime " +
            "does not have. Use a container runtime",
        ),
      );
      continue;
    }
    if (target.secret !== undefined) {
      const variable = boxTelemetrySecretVariable(project.runtime.name, target.name);
      if (taken.has(variable)) {
        warnings.push(
          leftOut(
            target.name,
            `deploy reads its key from ${variable}, and a credential or another target reads ` +
              "that variable too. Rename the target",
          ),
        );
        continue;
      }
      taken.add(variable);
    }
    targets.push(target);
  }
  return { targets, warnings };
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
      const result = outboundAuthFor(entry.secret, host.host, entry.name, (variable) =>
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
        ...(entry ? [entrySource(entry)] : []),
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

/** The source of the entry that names a host. */
function entrySource(entry: NonNullable<MappedHost["entry"]>): BoxNetworkSource {
  if (entry.table === "egress") {
    return { kind: "entry", egressEntry: entry.name, destinations: entry.destinations };
  }
  return {
    kind: "mcp",
    mcpEntry: entry.name,
    destinations: entry.destinations,
    ...(entry.secret && { secret: entry.secret }),
  };
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
    const entry = host.sources.find((source): source is EntrySource => source.kind !== "rule");
    if (!host.reachable) {
      if (!entry) continue;
      const deny =
        host.forbiddenBy.length === 0
          ? ""
          : ` (${rules(host.forbiddenBy)} ${host.forbiddenBy.length > 1 ? "deny" : "denies"} it)`;
      warnings.push(
        `${host.authority}: your policy allows no request to this host${deny}, so ` +
          `${sourceLabel(entry)} gets no gateway target.`,
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

type EntrySource = Exclude<BoxNetworkSource, { kind: "rule" }>;

/** The entry of a source as a message names it: `[egress.github]` or `[mcp.docs]`. */
function sourceLabel(source: EntrySource): string {
  return source.kind === "entry" ? `[egress.${source.egressEntry}]` : `[mcp.${source.mcpEntry}]`;
}

/**
 * A warning for each target of the network's Box gateway in `spec`, as build writes it, that the
 * gateway signs with its own role for an endpoint that no policy of that role allows. The Bedrock
 * policy file that build writes allows the Bedrock runtime host, and the Memory policy file the
 * Memory host; a gateway that imports its role is the user's to grant.
 */
export function boxGatewayIamWarnings(
  spec: ProjectSpec,
  network: Pick<BoxNetwork, "gateway" | "grantedActions" | "region">,
): string[] {
  const gateway = spec.agentCoreGateways.find(({ name }) => name === network.gateway);
  if (!gateway || gateway.executionRoleArn) return [];
  // Build writes these two files, so each one counts when it is listed, not by its actions.
  const listed = gateway.additionalPolicies ?? [];
  const memoryListed = listed.includes(BOX_MEMORY_POLICY_FILE);
  const bedrockListed = listed.includes(BOX_BEDROCK_POLICY_FILE);
  const granted = network.grantedActions;
  const grantsService = (service: string) =>
    granted.some((action) => action === "*" || action.toLowerCase().startsWith(`${service}:`));
  /** Whether the role has a permission for `service`, whatever its endpoint. */
  const holds = (service: string) =>
    (service === "bedrock" && bedrockListed) ||
    (service === "bedrock-agentcore" && memoryListed) ||
    grantsService(service);
  const grants = (action: string) => granted.some((pattern) => actionMatches(pattern, action));
  const allows = (api: AwsEndpointApi, host: string): boolean => {
    switch (api) {
      case "bedrock-runtime":
        return bedrockListed || grants("bedrock:InvokeModel");
      case "bedrock-control":
        return granted.some(grantsBedrockControlPlane);
      case "bedrock-agentcore":
        return (
          (memoryListed && host === boxGatewayAgentCoreHost(network.region)) ||
          grantsService("bedrock-agentcore")
        );
      case "lambda-url":
        return grants("lambda:InvokeFunctionUrl");
    }
  };
  const warnings: string[] = [];
  for (const target of gateway.targets) {
    const auth = target.outboundAuth;
    if (auth?.type !== "GATEWAY_IAM_ROLE" || !auth.service) continue;
    const at = target.passthrough && parseEndpoint(target.passthrough.endpoint);
    const endpoint = at && awsEndpoint(at.host);
    const host = at && hostKey(at.host, at.port);
    if (endpoint && host ? allows(endpoint.api, host) : holds(auth.service)) continue;
    warnings.push(
      endpoint && holds(auth.service)
        ? `Target '${target.name}' calls ${host} with the gateway's role, which has no ` +
            `${auth.service} permissions for that host. Add an IAM policy file to ` +
            `additionalPolicies of the '${network.gateway}' gateway.`
        : `Target '${target.name}' calls ${auth.service} with the gateway's role, which has no ` +
            `${auth.service} permissions. Add an IAM policy file to additionalPolicies of the ` +
            `'${network.gateway}' gateway.`,
    );
  }
  return warnings;
}

/** Whether the IAM action `pattern` matches `action`, in any case, with `*` and `?` wildcards. */
function actionMatches(pattern: string, action: string): boolean {
  const source = pattern
    .split(/([*?])/)
    .map((part) =>
      part === "*" ? ".*" : part === "?" ? "." : part.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`, "i").test(action);
}

/**
 * Whether the IAM action `pattern` allows an action of the Bedrock control plane: `*`, or a
 * `bedrock:` pattern that can match an action other than the runtime ones, `CountTokens` and each
 * action whose name starts with `InvokeModel`.
 */
function grantsBedrockControlPlane(pattern: string): boolean {
  const lower = pattern.toLowerCase();
  if (lower === "*") return true;
  if (!lower.startsWith("bedrock:")) return false;
  const wildcard = lower.search(/[*?]/);
  const fixed = wildcard === -1 ? lower : lower.slice(0, wildcard);
  if (fixed.startsWith("bedrock:invokemodel")) return false;
  return wildcard !== -1 || lower !== "bedrock:counttokens";
}
