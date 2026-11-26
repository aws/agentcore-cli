/**
 * The Box network model of one box runtime: the box profile parsed and evaluated once, with each
 * host's outbound auth and gateway target, the `env://` routes its targets need a credential for,
 * the policy files to stage, and every warning and failure. Build, deploy, and staging write from
 * it.
 */
import {
  credentialEnvironmentVariableNames,
  credentialEnvVarName,
  type Credential,
} from "../../../projectSchemas/credential";
import type {
  AgentCoreGateway,
  AgentCoreGatewayTarget,
  OutboundAuth,
} from "../../../projectSchemas/gateway";
import type { ProjectSpec } from "../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { BOX_GATEWAY_TARGETS_FILE } from "../boxGatewayTargets";
import { BOX_BEDROCK_POLICY_FILE } from "../boxMemory";
import { boxEgressCredentialName, boxRouteCredentialProblem } from "../boxProfileCredentials";
import type { BoxEnvRoute } from "../boxProfileEgress";
import { boxTelemetrySecretVariable } from "../boxTelemetrySecrets";
import { buildHostMap, entryLabel, entryRef, type MappedHost } from "./hostMap";
import {
  BOX_EGRESS_TARGET_PREFIX,
  awsEndpoint,
  boxGatewayBedrockHost,
  hasBoxSignedSuffix,
  outboundAuthFor,
  parseEndpoint,
  targetNameFor,
  type AwsEndpointApi,
  type BoxEgressSecret,
} from "./egress";
import { describeEntry, describeRule, ruleOrigin } from "./places";
import { placeOf, type ParsedPolicy } from "./policyParser";
import { runtimeProfileContext } from "../runtimeProfile/context";
import { deriveRuntimeProfile } from "../runtimeProfile/derive";
import { defaultTracesTelemetry, runtimeProfileHeader } from "../runtimeProfile/rules/additions";
import type { TomlTable } from "../runtimeProfile/types";
import type { ParsedProfile } from "./profileParser";
import { withDeployRegion, type CloudWatchTelemetry, type ThirdPartyTelemetry } from "./telemetry";
import type { PassthroughGatewayCheck } from "../backends/cdk/compatibility";
import { projectGatewaysOf, type BoxProjectGateway } from "./projectGateways";
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

export { BOX_GATEWAY_TARGETS_FILE };

/** How the gateway authenticates its requests to a host. */
export type BoxEgressAuth =
  | { readonly kind: "none" }
  /** Absent `region` only for a target of the user's own that has no region. */
  | { readonly kind: "iam"; readonly service: string; readonly region?: string }
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
export type BoxHostSource =
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
  readonly sources: readonly BoxHostSource[];
  readonly outboundAuth: BoxEgressAuth;
  /** Whether Box allows at least one request to the host. */
  readonly reachable: boolean;
  /**
   * The gateway target of a reachable host, also of one whose API key has no credential in
   * agentcore.json, which the gateway targets writer then skips.
   */
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
  /** The region build builds for: of the Box gateway and its `bedrock` target. */
  readonly region: string;
  /**
   * The `[egress]` entries' hosts in profile order, then the HTTP `[mcp]` servers' hosts, then the
   * hosts only the permits name.
   */
  readonly hosts: readonly BoxNetworkHost[];
  /** The `env://` route of each target that sends an API key, for the credentials writer. */
  readonly envRoutes: readonly BoxEnvRoute[];
  /**
   * The gateways of the project that the agent calls through the Box gateway, each with its
   * target; absent means none.
   */
  readonly projectGateways?: readonly BoxProjectGateway[];
  /**
   * The targets of the gateway that build owns, which it adds, rewrites, and removes: each one it
   * wrote before, and the new target of each host. Build keeps every other target as it is.
   */
  readonly managedTargets: ReadonlySet<string>;
  /**
   * The policy files, relative to the agent's local box folder, to copy beside the AgentCore
   * Runtime profile.
   */
  readonly policyFiles: readonly string[];
  /**
   * The CloudWatch targets of the profile's `[telemetry]`, then the default X-Ray target of
   * {@link runtimeProfile} (`DEFAULT_TRACES_TARGET`); absent means none.
   */
  readonly telemetry?: readonly CloudWatchTelemetry[];
  /**
   * The AgentCore Runtime profile that build derives from the local profile (`deriveRuntimeProfile`
   * in runtimeProfile/derive.ts), which the runtime profile writer stages; absent when build has no
   * profile text. It can name a route that the staged file does not have: the writer removes each
   * route to a target that build does not write (withoutUnsentRoutes in boxNetworkWriters.ts).
   */
  readonly runtimeProfile?: TomlTable;
  /** The comment lines above {@link runtimeProfile} in the staged file. */
  readonly runtimeProfileHeader?: readonly string[];
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
   * The gateway's targets, with the `bedrock` target that build adds for the runtime's model calls
   * (`addBoxGatewayTargets`).
   */
  readonly targets: readonly AgentCoreGatewayTarget[];
  /** The IAM actions that the gateway's `additionalPolicies` files grant, except build's own. */
  readonly grantedActions: readonly string[];
  /**
   * What the check of the @aws/agentcore-cdk of the project gives for a target with
   * `passthrough.gateway` (`cdkAcceptsPassthroughGateway`). Absent means no check, and no gateway
   * of the project gets a target.
   */
  readonly projectGatewayCheck?: PassthroughGatewayCheck;
  /**
   * The targets that {@link BOX_GATEWAY_TARGETS_FILE} names for the gateway. Absent when the file
   * does not name the gateway, which build last built before it kept the file: then build owns each
   * target whose name starts with `egress-` and that has the shape build writes.
   */
  readonly ownedTargets?: ReadonlySet<string>;
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
  const reached = projectGatewaysOf(
    project.spec,
    project.runtime,
    project.projectGatewayCheck ?? { accepts: false, reason: "refuses" },
  );
  const targets = hostTargets(map.hosts, project, reached.gateways, located, parsed.profile.path);
  failures.push(...targets.failures);
  const thirdParty = runtimeTelemetry(parsed.profile, project, targets.hosts);
  const telemetry =
    parsed.profile.telemetry &&
    withDeployRegion(parsed.profile.telemetry, project.region, parsed.profile.path);
  const source = parsed.profile.source;
  const context =
    source &&
    runtimeProfileContext({
      spec: project.spec,
      runtime: project.runtime,
      profileFile: parsed.profile.path,
      region: project.region,
      gateway: { name: project.gateway, targets: project.targets, managed: targets.managed },
      hosts: targets.hosts,
      projectGateways: reached.gateways,
      telemetry: telemetry?.telemetry ?? [],
      thirdPartyTelemetry: thirdParty.targets,
      ruleIds: new Set(
        parsed.statements
          .filter(
            ({ id, span }) =>
              placeOf(parsed, span) !== undefined || ruleOrigin(parsed, id).by !== "box",
          )
          .map(({ id }) => id),
      ),
      places: source.places,
    });
  const derived = source && context && deriveRuntimeProfile(source.table, context);
  failures.push(
    ...(derived?.problems ?? []).map(({ code, reason, place }) => ({ code, reason, place })),
  );
  const defaultTraces = derived ? defaultTracesTelemetry(derived.profile, project.region) : [];
  const sent =
    telemetry || defaultTraces.length > 0
      ? [...(telemetry?.telemetry ?? []), ...defaultTraces]
      : undefined;
  return {
    runtime: project.runtime.name,
    gateway: project.gateway,
    region: project.region,
    hosts: targets.hosts,
    envRoutes: envRoutesOf(targets.hosts),
    projectGateways: reached.gateways,
    managedTargets: targets.managed,
    policyFiles: parsed.profile.policyFiles,
    ...(sent && { telemetry: sent }),
    ...(derived &&
      context && {
        runtimeProfile: derived.profile,
        runtimeProfileHeader: runtimeProfileHeader(context, derived.profile),
      }),
    ...(thirdParty.targets.length > 0 && { thirdPartyTelemetry: thirdParty.targets }),
    grantedActions: project.grantedActions,
    warnings: [
      ...thirdParty.warnings,
      ...map.hosts.flatMap(({ authority, uncheckedBy }) =>
        uncheckedBy.map((ruleId) => {
          const { place, subject } = describeRule(parsed, ruleId);
          return (
            `${place}: ${subject} has more path conditions than build can check together, so ` +
            `build cannot tell whether your policy allows a request to ${authority}. Build gives ` +
            "the host a gateway target, and Box still applies the rule."
          );
        }),
      ),
      ...targets.warnings,
      ...hostWarnings(targets.hosts),
      ...map.websocketOnly.map(({ ruleId, span }) => {
        const { place, subject } = describeRule(parsed, ruleId, span);
        return (
          `${place}: ${subject} allows only WebSocket connections, and build adds no gateway ` +
          "target for a WebSocket, so it skips this rule."
        );
      }),
      ...(telemetry?.warnings ?? []),
      ...reached.warnings,
      ...(derived?.warnings ?? []),
    ],
    failures,
  };
}

/**
 * The `env://` route of each host whose target sends an API key, once for each route and variable:
 * an `[egress]` entry and an `[mcp]` server of one name can read one credential from its own
 * variable and from one other, and build copies the other's key. An HTTP MCP server's route has
 * the server's name.
 */
function envRoutesOf(hosts: readonly BoxNetworkHost[]): BoxEnvRoute[] {
  const routes: BoxEnvRoute[] = [];
  for (const { target, outboundAuth, sources } of hosts) {
    const entry = sources.find((source): source is EntrySource => source.kind !== "rule");
    if (target === undefined || outboundAuth.kind !== "apiKey" || !entry) continue;
    const route = entry.kind === "entry" ? entry.egressEntry : entry.mcpEntry;
    const { variable } = outboundAuth;
    if (routes.some((other) => other.route === route && other.variable === variable)) continue;
    routes.push({ route, variable });
  }
  return routes;
}

/**
 * The third-party telemetry targets that the AgentCore Runtime profile carries, and a warning for
 * each one it leaves out. Box reads the key of a target on AgentCore Runtime from AWS Secrets
 * Manager. A CodeZip runtime carries no target with a key, because its
 * Runtime has no AWS CLI for Box to read the key with. A target with a key is also left out when
 * the variable deploy reads its key from is a variable that a credential reads, or that another
 * target of the profile reads, so deploy never sends one key to the wrong destination. A target of
 * a PRIVATE_VPC runtime stays, with a warning: the VPC has no internet path, and its DNS firewall
 * resolves only AWS service names, so no data gets to the target.
 */
function runtimeTelemetry(
  profile: ParsedProfile,
  project: BoxNetworkProject,
  hosts: readonly BoxNetworkHost[],
): { targets: ThirdPartyTelemetry[]; warnings: string[] } {
  const leftOut = (name: string, reason: string) =>
    `${profile.path}: the AgentCore Runtime profile leaves out [telemetry.${name}]: ${reason}.`;
  const warnings = (profile.leftOutTelemetry ?? []).map(({ name, reason }) =>
    leftOut(name, reason),
  );
  const taken = new Set([
    ...project.spec.credentials.flatMap(credentialEnvironmentVariableNames),
    ...hosts.flatMap(({ outboundAuth }) =>
      outboundAuth.kind === "apiKey" ? [credentialEnvVarName(outboundAuth.credentialName)] : [],
    ),
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
    if (project.runtime.containment === "PRIVATE_VPC") {
      const host = thirdPartyHost(target);
      warnings.push(
        `${profile.path}: [telemetry.${target.name}] sends to ${host}, but runtime ` +
          `${project.runtime.name} uses a private VPC. Box tries to send, but no data gets to ` +
          `${host}. The VPC has no internet path, and its DNS firewall resolves only AWS service ` +
          `names. To send to ${host}, use the default network: remove "containment" and ` +
          `"network" from runtime ${project.runtime.name} in agentcore.json. You can also use ` +
          "`agentcore create` again without `--containment private-vpc`.",
      );
    }
    targets.push(target);
  }
  return { targets, warnings };
}

/** The address a box sends a vendor's spans to when its `[telemetry]` table names no destination. */
const VENDOR_DESTINATIONS: Readonly<Record<string, string>> = {
  langfuse: "https://cloud.langfuse.com",
  langsmith: "https://api.smith.langchain.com",
};

/** The host that `target` sends to: its destination, else its vendor's default. */
function thirdPartyHost(target: ThirdPartyTelemetry): string {
  const named = target.keys.find(([key]) => key === "destination")?.[1];
  const destination = typeof named === "string" ? named : VENDOR_DESTINATIONS[target.kind];
  if (destination === undefined) return "its destination";
  try {
    return new URL(destination).host;
  } catch {
    return destination;
  }
}

/**
 * Whether build owns `target` of a gateway that {@link BOX_GATEWAY_TARGETS_FILE} does not name: its
 * name starts with `egress-`, and it has the shape build writes.
 */
export function isManagedTarget(target: AgentCoreGatewayTarget): boolean {
  return target.name.startsWith(BOX_EGRESS_TARGET_PREFIX) && unmanagedShape(target) === undefined;
}

/** The host map key of a passthrough target's endpoint, or `undefined` for another target. */
function endpointKey(target: AgentCoreGatewayTarget): string | undefined {
  const at = target.passthrough?.endpoint && parseEndpoint(target.passthrough.endpoint);
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
  gateways: readonly BoxProjectGateway[],
  located: (failure: ConversionFailure) => BoxNetworkFailure,
  profilePath: string,
): {
  hosts: BoxNetworkHost[];
  failures: BoxNetworkFailure[];
  managed: ReadonlySet<string>;
  warnings: string[];
} {
  const existing = project.targets;
  const failures: BoxNetworkFailure[] = [];
  const recorded = project.ownedTargets;
  const isManaged = (target: AgentCoreGatewayTarget) =>
    recorded ? recorded.has(target.name) : isManagedTarget(target);
  const warnings: string[] = [];
  for (const target of existing) {
    // The one build that takes a gateway's old egress- targets names each one it keeps.
    const kept =
      recorded === undefined && target.name.startsWith(BOX_EGRESS_TARGET_PREFIX)
        ? unmanagedShape(target)
        : undefined;
    if (kept !== undefined) {
      warnings.push(
        `${PROJECT_SPEC_PLACE}: build keeps the gateway target '${target.name}' as yours, ` +
          `because it ${kept}, which build does not write. Build does not change or remove it. ` +
          "Remove the target if build wrote it before and you do not use it.",
      );
    }
    const changed = recorded?.has(target.name) ? unmanagedShape(target) : undefined;
    if (changed === undefined) continue;
    failures.push({
      code: "MANAGED_TARGET_CHANGED",
      target: target.name,
      reason:
        `The gateway target '${target.name}' ${changed}, which build does not write, and ` +
        `${BOX_GATEWAY_TARGETS_FILE} names it as a target that build writes, so build does not ` +
        `change or remove it. Remove '${target.name}' from that file to keep the target as ` +
        "yours, or remove the target so build writes it again.",
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
  /**
   * The variable and the entry of each API key credential an entry takes for a variable that is
   * not the credential's own. Build copies the key of that variable to the credential's own, so an
   * entry that reads the credential's own variable takes the same key.
   */
  const keys = new Map<string, { readonly variable: string; readonly entry: string }>();
  /**
   * The API key credentials that build adds for the entries before this one, which a later entry
   * must not derive the same variable as, and the entries that already failed for their name.
   */
  const pending: Credential[] = [];
  const badNames = new Set<string>();
  const hosts = mapped.map((host, index): BoxNetworkHost => {
    let auth: BoxEgressAuth = { kind: "none" };
    let userTarget = false;
    const entry = host.entry;
    if (entry) {
      const result = outboundAuthFor(entry.secret, host.host, (variable) =>
        boxEgressCredentialName(project.spec.credentials, entry.name, variable),
      );
      if (!result.ok) failAt(host, result.code, result.reason);
      else if (result.userTarget) userTarget = true;
      else auth = result.auth;
      // Build names the credential after the entry when no credential reserves its variable, and
      // deploy would have no credential for a name `agentcore credentials add` refuses.
      if (
        auth.kind === "apiKey" &&
        auth.credentialName === entry.name &&
        !badNames.has(entry.name)
      ) {
        const problem = boxRouteCredentialProblem(
          [...project.spec.credentials, ...pending],
          entry.name,
        );
        if (problem !== undefined) {
          badNames.add(entry.name);
          failAt(
            host,
            "CREDENTIAL_NAME_INVALID",
            `reads its key from env://${auth.variable}, which build keeps in an API key ` +
              `credential named after the entry, and ${problem}. Rename the entry.`,
          );
        } else if (
          ![...project.spec.credentials, ...pending].some(({ name }) => name === entry.name)
        ) {
          pending.push({ authorizerType: "ApiKeyCredentialProvider", name: entry.name });
        }
      }
      const alias =
        auth.kind === "apiKey" && auth.variable !== credentialEnvVarName(auth.credentialName)
          ? auth
          : undefined;
      const holder = alias && keys.get(alias.credentialName);
      if (alias && holder && holder.variable !== alias.variable) {
        failAt(
          host,
          "API_KEY_CREDENTIAL_SHARED",
          `needs the API key credential '${alias.credentialName}' for env://${alias.variable}, ` +
            `and ${holder.entry} takes that credential for env://${holder.variable}. One ` +
            "credential holds one key. Rename the entry.",
        );
      } else if (alias && !holder) {
        keys.set(alias.credentialName, { variable: alias.variable, entry: entryLabel(entry) });
      }
    }
    let target: string | undefined;
    if (host.reachable) {
      // Only a target of the user's own signs for a host that Box does not sign.
      const held = existing.find(
        (candidate) =>
          !claimed.has(candidate.name) &&
          endpointKey(candidate) === host.authority &&
          !(userTarget && isManaged(candidate)),
      );
      if (held) {
        claimed.add(held.name);
        reused.add(index);
        // The user's target names the service and the region, and build takes them as they are.
        const signs = held.outboundAuth;
        const signed = signs?.type === "GATEWAY_IAM_ROLE" ? signs : undefined;
        if (userTarget && signed?.service !== undefined) {
          auth = {
            kind: "iam",
            service: signed.service,
            ...(signed.region !== undefined && { region: signed.region }),
          };
        }
        const wanted: OutboundAuth | undefined = userTarget
          ? (signed ?? { type: "GATEWAY_IAM_ROLE" })
          : targetOutboundAuth(auth);
        const conflict = isManaged(held)
          ? undefined
          : targetConflict(held, host, wanted, profilePath);
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
      } else if (userTarget && entry && !hasBoxSignedSuffix(host.host)) {
        failAt(
          host,
          "UNSIGNABLE_HOST",
          `signs requests to ${host.host} with ${entry.secret!.ref}, and build cannot find the ` +
            "AWS service and the region of this host. Use an env:// secret for this host, or " +
            "remove the secret. For an AWS API on a custom domain, add a GATEWAY_IAM_ROLE " +
            `passthrough target for https://${host.authority} to the '${project.gateway}' gateway.`,
        );
      } else if (userTarget && entry) {
        const { place, reason } = located({
          code: "UNSIGNABLE_HOST",
          ...entryRef(entry),
          reason:
            `signs requests to ${host.host} with ${entry.secret!.ref}, and Box does not sign ` +
            "for this host name, so build cannot find its service and its region and makes no " +
            "gateway target for it. The AgentCore Runtime box profile leaves this entry out, and " +
            `nothing signs the requests to ${host.authority}. To sign them, add a passthrough ` +
            `target for https://${host.authority} to the '${project.gateway}' gateway in ` +
            "agentcore.json, with protocolType CUSTOM and outboundAuth type GATEWAY_IAM_ROLE. " +
            "Give it the service and the region of the host. Then add an IAM policy file with " +
            "the permissions for the host to additionalPolicies of that gateway.",
        });
        warnings.push(`${place}: ${reason}`);
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
    if (!isManaged(target)) owners.set(target.name, `the gateway target '${target.name}'`);
  }
  const gatewayOf = new Map<string, string>();
  for (const gateway of gateways) {
    const other = gatewayOf.get(gateway.target);
    if (other !== undefined) {
      failures.push({
        code: "TARGET_NAME_COLLISION",
        target: gateway.target,
        reason:
          `The gateways '${other}' and '${gateway.name}' of this project would both get the ` +
          `gateway target '${gateway.target}'. Rename one of the gateways.`,
        place: PROJECT_SPEC_PLACE,
      });
      continue;
    }
    gatewayOf.set(gateway.target, gateway.name);
    const owner = owners.get(gateway.target);
    if (owner !== undefined) {
      failures.push({
        code: "TARGET_NAME_COLLISION",
        target: gateway.target,
        reason:
          `The gateway '${gateway.name}' of this project would get the gateway target ` +
          `'${gateway.target}', and ${owner} has that name. Rename that target.`,
        place: PROJECT_SPEC_PLACE,
      });
      continue;
    }
    owners.set(gateway.target, `the target that build adds for the gateway '${gateway.name}'`);
  }
  const describeHost = (host: MappedHost) =>
    host.entry ? `${entryLabel(host.entry)} for ${host.authority}` : `the host ${host.authority}`;
  for (const index of reused) {
    const name = hosts[index]!.target!;
    const gateway = gatewayOf.get(name);
    if (gateway !== undefined) {
      // The host keeps its target, so the gateway cannot have that name.
      failAt(
        mapped[index]!,
        "TARGET_NAME_COLLISION",
        `takes the gateway target '${name}' for ${hosts[index]!.authority}, and the target that ` +
          `build adds for the gateway '${gateway}' has that name. Rename the entry or the gateway.`,
      );
      continue;
    }
    owners.set(name, describeHost(mapped[index]!));
  }
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
  const kept = existing.filter((target) => !isManaged(target) && !claimed.has(target.name));
  const needed = served + gateways.length + kept.length;
  if (needed > MAX_GATEWAY_TARGETS) {
    const builds =
      gateways.length === 0
        ? `${served} for the hosts of the Box profile and`
        : `${served} for the hosts of the Box profile, ${gateways.length} for the gateways of ` +
          "the project, and";
    failures.push({
      code: "TOO_MANY_TARGETS",
      reason:
        `The gateway '${project.gateway}' needs ${needed} targets, ${builds} ${kept.length} of ` +
        `your own, and a gateway can have at most ${MAX_GATEWAY_TARGETS}. Remove hosts from the ` +
        "profile, or targets from the gateway.",
      place: profilePath,
    });
  }
  const managed = managedTargetsOf(existing.filter(isManaged), hosts, reused);
  // The target of each gateway of the project is build's too, so the record lists it and a later
  // build can remove it.
  for (const gateway of gateways) managed.add(gateway.target);
  return { hosts, failures, managed, warnings };
}

/**
 * The targets of a Box gateway that build owns (`BoxNetwork.managedTargets`), which the writers
 * change and remove and the record lists: each target of `owned`, and the new target of each host
 * that takes no target the gateway has (`reused`). Each other kind of target that build writes
 * belongs in this set too.
 */
function managedTargetsOf(
  owned: readonly AgentCoreGatewayTarget[],
  hosts: readonly BoxNetworkHost[],
  reused: ReadonlySet<number>,
): Set<string> {
  const managed = new Set(owned.map(({ name }) => name));
  hosts.forEach(({ target }, index) => {
    if (target !== undefined && !reused.has(index)) managed.add(target);
  });
  return managed;
}

/** The source of the entry that names a host. */
function entrySource(entry: NonNullable<MappedHost["entry"]>): BoxHostSource {
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
  // A target that names a gateway of the project has no endpoint.
  if (endpoint !== undefined && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(endpoint)) {
    return `has the endpoint ${endpoint}`;
  }
  const auth = target.outboundAuth;
  const fields = auth ? Object.keys(auth).sort().join(",") : "";
  const shapes: Record<string, string[]> = {
    NONE: ["type"],
    // A target to a gateway of the project signs in the region of the stack, so it has no region.
    GATEWAY_IAM_ROLE: [
      target.passthrough.gateway === undefined ? "region,service,type" : "service,type",
    ],
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
  wanted: OutboundAuth | undefined,
  profilePath: string,
): string | undefined {
  const endpoint = target.passthrough?.endpoint && parseEndpoint(target.passthrough.endpoint);
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
    if (host.enforcedByBox.length === 0 || host.target === undefined) continue;
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

type EntrySource = Exclude<BoxHostSource, { kind: "rule" }>;

/** The entry of a source as a message names it: `[egress.github]` or `[mcp.docs]`. */
function sourceLabel(source: EntrySource): string {
  return source.kind === "entry" ? `[egress.${source.egressEntry}]` : `[mcp.${source.mcpEntry}]`;
}

/**
 * A warning for each target of the network's Box gateway in `spec`, as build writes it, that the
 * gateway signs with its own role for an endpoint that no policy of that role allows. The Bedrock
 * policy file that build writes allows the Bedrock runtime host of the build region; a gateway that
 * imports its role is the user's to grant.
 */
export function boxGatewayIamWarnings(
  spec: ProjectSpec,
  network: Pick<BoxNetwork, "runtime" | "gateway" | "grantedActions" | "region">,
): string[] {
  const gateway = boxGatewayOf(spec, network.runtime);
  if (!gateway || gateway.executionRoleArn) return [];
  // Build writes this file, so it counts when it is listed, not by its actions.
  const listed = gateway.additionalPolicies ?? [];
  const bedrockListed = listed.includes(BOX_BEDROCK_POLICY_FILE);
  const granted = network.grantedActions;
  const grantsService = (service: string) =>
    granted.some((action) => action === "*" || action.toLowerCase().startsWith(`${service}:`));
  /** Whether the role has a permission for `service`, whatever its endpoint. */
  const holds = (service: string) =>
    (service === "bedrock" && bedrockListed) || grantsService(service);
  const grants = (action: string) => granted.some((pattern) => actionMatches(pattern, action));
  const allows = (api: AwsEndpointApi, host: string): boolean => {
    switch (api) {
      case "bedrock-runtime":
        return (
          (bedrockListed && host === boxGatewayBedrockHost(network.region)) ||
          grants("bedrock:InvokeModel")
        );
      case "bedrock-control":
        return granted.some(grantsBedrockControlPlane);
      case "bedrock-agentcore":
        return grantsService("bedrock-agentcore");
      case "lambda-url":
        return grants("lambda:InvokeFunctionUrl");
      case "gateway":
        return grants("bedrock-agentcore:InvokeGateway");
    }
  };
  const warnings: string[] = [];
  for (const target of gateway.targets) {
    const auth = target.outboundAuth;
    if (auth?.type !== "GATEWAY_IAM_ROLE" || !auth.service) continue;
    // The CDK library grants the role InvokeGateway on the gateway that the target names.
    if (target.passthrough?.gateway !== undefined) continue;
    const at = target.passthrough?.endpoint && parseEndpoint(target.passthrough.endpoint);
    const endpoint = at && awsEndpoint(at.host);
    const host = at && hostKey(at.host, at.port);
    if (endpoint && host ? allows(endpoint.api, host) : grantsService(auth.service)) continue;
    warnings.push(
      host && holds(auth.service)
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
