/**
 * The host map: every `host` or `host:port` that an `[egress]` destination or a permit with a
 * fixed host names, each decided by evaluating the whole Box policy on sample requests to it, as
 * Box does. It is the one place that evaluates the policy.
 */
import {
  clausesFor,
  holds,
  isUnknownBoxAction,
  pinnedValue,
  type Clause,
  type ClauseSet,
  type FieldAtom,
  type NetworkAction,
} from "./conditions";
import type { Statement } from "./dogwood";
import {
  BoxEgressEntrySchema,
  BoxMcpEntrySchema,
  parseDestination,
  targetHostProblem,
  type BoxEgressSecret,
  type Destination,
} from "./egress";
import {
  ROUTABLE_METHODS,
  hostKey,
  type ConversionFailure,
  type FailureCode,
  type HostDecision,
  type RoutableMethod,
  type SampleRequest,
} from "./types";

/** Every method a rule can name; only {@link ROUTABLE_METHODS} reach a passthrough target. */
const HTTP_METHODS = [
  "GET",
  "POST",
  "DELETE",
  "PUT",
  "PATCH",
  "HEAD",
  "OPTIONS",
  "CONNECT",
  "TRACE",
];

/** The rules the box CLI writes into every profile, which Box enforces for every host. */
const BOX_CLI_BUILT_INS: ReadonlySet<string> = new Set(["metadata_hosts", "metadata_addresses"]);

/** A path segment no rule names, which stands for every path below a sample that no rule names. */
export const SENTINEL_SEGMENT = "§";

/** The network inputs of a box profile, parsed. */
export interface HostMapInput {
  /** The policy files' statements, then the rules the box CLI adds. */
  readonly statements: readonly Statement[];
  readonly egress: Readonly<Record<string, unknown>>;
  readonly mcp: Readonly<Record<string, unknown>>;
}

/** The `[egress]` entry that names a host. */
export interface MappedEntry {
  readonly egressEntry: string;
  /** The entry's destinations on this host. */
  readonly destinations: readonly string[];
  /** Whether the entry names more than one host. */
  readonly split: boolean;
  readonly secret?: BoxEgressSecret;
}

/** One host of the host map, and how the whole Box policy decides it. */
export interface MappedHost {
  readonly host: string;
  readonly port: number;
  /** `host`, or `host:port` for a port other than 443. */
  readonly authority: string;
  readonly entry?: MappedEntry;
  /** The permits that name the host with a fixed host, by `@id`, in policy order. */
  readonly namedBy: readonly string[];
  readonly decision: HostDecision;
  /** The forbids that deny a sample request a permit allows, by `@id`. */
  readonly forbiddenBy: readonly string[];
  /** The rules that limit what Box allows to the host, which Box enforces and a gateway does not. */
  readonly enforcedByBox: readonly string[];
  /** Whether Box allows at least one sample request to the host. */
  readonly reachable: boolean;
}

export interface HostMap {
  /** The `[egress]` entries' hosts in profile order, then the hosts only the permits name. */
  readonly hosts: readonly MappedHost[];
  readonly failures: readonly ConversionFailure[];
}

/** The host map of the network inputs, and the policy's decision on each host. */
export function buildHostMap(input: HostMapInput): HostMap {
  return new HostMapBuilder().run(input);
}

interface Node {
  readonly host: string;
  readonly port: number;
  readonly entry?: MappedEntry;
  readonly namedBy: string[];
}

interface Rule {
  readonly statement: Statement;
  readonly order: number;
  readonly actions: ReadonlyMap<NetworkAction, Extract<ClauseSet, { ok: true }>>;
  readonly failures: FailureCode[];
}

interface RuleClause {
  readonly ruleId: string;
  readonly order: number;
  readonly clause: Clause;
}

/** The live clauses of the policy, by action and effect, which every decision reads. */
interface Policy {
  readonly requestPermits: readonly RuleClause[];
  readonly requestForbids: readonly RuleClause[];
  readonly connectPermits: readonly RuleClause[];
  readonly connectForbids: readonly RuleClause[];
}

class HostMapBuilder {
  private readonly failures: ConversionFailure[] = [];
  private readonly nodes = new Map<string, Node>();
  /** Hosts and ports of `[egress]` entries that failed and no other entry holds. */
  private readonly blocked = new Map<string, string>();
  /** The rule ids the box CLI adds for an entry that failed, which fail with it. */
  private readonly covered = new Set<string>();
  private readonly mcpHosts = new Set<string>();

  run(input: HostMapInput): HostMap {
    const failedEntries: { name: string; destinations: Destination[] }[] = [];
    for (const [name, entry] of Object.entries(input.egress)) {
      const failed = this.addEgressEntry(name, entry);
      if (failed) failedEntries.push({ name, destinations: failed });
    }
    for (const { name, destinations } of failedEntries) {
      for (const suffix of ["connect", "request"]) this.covered.add(`route_${name}_${suffix}`);
      for (const d of destinations) {
        const key = hostKey(d.host, d.port);
        if (!this.nodes.has(key)) this.blocked.set(key, name);
      }
    }
    for (const [name, entry] of Object.entries(input.mcp)) this.addMcpEntry(name, entry);

    const rules: Rule[] = [];
    const seen = new Set<string>();
    input.statements.forEach((statement, order) => {
      if (this.covered.has(statement.id)) return;
      if (seen.has(statement.id)) {
        this.failures.push({
          code: "DUPLICATE_RULE_ID",
          ruleId: statement.id,
          reason: `two rules have the @id ${JSON.stringify(statement.id)}`,
          span: statement.span,
        });
      }
      seen.add(statement.id);
      const rule = this.classify(statement, order);
      if (rule) rules.push(rule);
    });

    for (const rule of rules) if (rule.statement.effect === "permit") this.bindPermit(rule);
    this.addRuleNodes(rules);
    const live = livePolicy(rules);
    const hosts = [...this.nodes.values()].map((node) => decide(node, live));
    return { hosts, failures: this.failures };
  }

  // ---------------------------------------------------------------------------
  // Sources
  // ---------------------------------------------------------------------------

  /** Adds the entry's nodes, or records why it fails and returns the destinations it names. */
  private addEgressEntry(name: string, raw: unknown): Destination[] | undefined {
    const problems: { code: FailureCode; reason: string }[] = [];
    const parsed = BoxEgressEntrySchema.safeParse(raw);
    const destinations = parsed.success
      ? parsed.data.destinations.map((text) => ({ text, parsed: parseDestination(text) }))
      : [];
    const groups: { key: string; first: Destination; texts: string[] }[] = [];
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "entry"}: ${i.message}`);
      problems.push({
        code: "INVALID_INPUT",
        reason: `it is not a valid egress entry: ${issues.join("; ")}`,
      });
    } else {
      problems.push(...entryProblems(parsed.data, destinations));
      for (const { text, parsed: d } of destinations) {
        if (!d || d.wildcard) continue;
        const key = hostKey(d.host, d.port);
        const group = groups.find((g) => g.key === key);
        if (group) group.texts.push(text);
        else groups.push({ key, first: d, texts: [text] });
      }
    }

    if (parsed.success && problems.length === 0) {
      for (const group of groups) {
        const holder = this.nodes.get(group.key)?.entry?.egressEntry;
        if (holder === undefined) continue;
        problems.push({
          code: "EGRESS_DESTINATION_OVERLAP",
          reason: `it names ${group.key}, which [egress.${holder}] names too; one host and port is one entry and one gateway target, as Box requires. Keep ${group.key} in one of [egress.${holder}] and [egress.${name}]`,
        });
      }
    }
    if (parsed.success && problems.length === 0) {
      for (const group of groups) {
        this.nodes.set(group.key, {
          host: group.first.host,
          port: group.first.port,
          entry: {
            egressEntry: name,
            destinations: group.texts,
            split: groups.length > 1,
            ...(parsed.data.secret && { secret: parsed.data.secret }),
          },
          namedBy: [],
        });
      }
      return undefined;
    }
    for (const { code, reason } of problems) {
      this.failures.push({ code, egressEntry: name, reason: `[egress.${name}]: ${reason}` });
    }
    return destinations.flatMap(({ parsed: d }) => (d && !d.wildcard ? [d] : []));
  }

  /** Fails an HTTP MCP server at its entry; its own rules fail with it. */
  private addMcpEntry(name: string, raw: unknown): void {
    const parsed = BoxMcpEntrySchema.safeParse(raw);
    if (!parsed.success) {
      this.failures.push({
        code: "INVALID_INPUT",
        mcpEntry: name,
        reason: `[mcp.${name}]: it is not a valid MCP entry`,
      });
      return;
    }
    if (parsed.data.type !== "http") return;
    for (const suffix of ["connect", "request", "call"]) this.covered.add(`mcp_${name}_${suffix}`);
    for (const text of parsed.data.destinations ?? []) {
      const destination = parseDestination(text);
      if (destination) this.mcpHosts.add(destination.host);
    }
    this.failures.push({
      code: "MCP_OVER_HTTP",
      mcpEntry: name,
      reason:
        `[mcp.${name}]: it is an MCP server over HTTP, and Box cannot route an MCP server ` +
        "through a gateway backend",
    });
  }

  /**
   * Adds or joins a node for each fixed host a permit names: `host:N` for a permit that fixes the
   * port to N, and the port-less `host` for a permit that names no port.
   */
  private addRuleNodes(rules: readonly Rule[]): void {
    for (const rule of rules) {
      if (rule.failures.length > 0 || rule.statement.effect !== "permit") continue;
      for (const [action, set] of rule.actions) {
        for (const clause of set.clauses) {
          const atoms = (field: FieldAtom["field"]) =>
            clause.fields.filter((a) => a.field === field);
          const host = pinnedValue(atoms("host"), "host");
          if (typeof host !== "string" || !atoms("host").every((a) => holds(a, host))) continue;
          if (this.mcpHosts.has(host)) continue;
          const pinned = pinnedValue(atoms("port"), "port");
          let port: number;
          if (typeof pinned === "number") {
            if (!atoms("port").every((a) => holds(a, pinned)) || pinned === 80) continue;
            port = pinned;
          } else if (atoms("port").every((a) => holds(a, 443))) {
            port = 443;
          } else {
            if (action === "http:request") {
              this.ruleFailure(
                rule,
                "UNCONSTRAINED_PORT",
                `it allows ${host} on ports ${atoms("port")
                  .map((a) => a.text)
                  .join(" and ")} with no fixed port; a gateway target needs one`,
              );
            }
            continue;
          }
          const key = hostKey(host, port);
          if (this.blocked.has(key)) continue;
          let node = this.nodes.get(key);
          if (!node) {
            node = { host, port, namedBy: [] };
            this.nodes.set(key, node);
          }
          if (!node.namedBy.includes(rule.statement.id)) node.namedBy.push(rule.statement.id);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  /** The statement's network clauses, or `undefined` for a rule that decides no host. */
  private classify(statement: Statement, order: number): Rule | undefined {
    const scope = statement.action;
    const entities =
      scope.kind === "any" ? [] : scope.kind === "eq" ? [scope.entity] : scope.entities;
    const unknown = entities.find(isUnknownBoxAction);
    if (unknown) {
      this.failRule(
        statement,
        "UNKNOWN_ACTION",
        `it names Box::Action::"${unknown.id}", which Box does not define`,
      );
      return undefined;
    }
    const network: NetworkAction[] =
      scope.kind === "any"
        ? ["http:request", "net:connect"]
        : (["http:request", "net:connect"] as const).filter((a) =>
            entities.some((e) => e.type.join("::") === "Box::Action" && e.id === a),
          );
    if (network.length === 0) return undefined;
    const actions = new Map<NetworkAction, Extract<ClauseSet, { ok: true }>>();
    for (const action of network) {
      const set = clausesFor(statement, action);
      if (!set.ok) {
        this.failRule(statement, set.code, set.reason);
        return undefined;
      }
      actions.set(action, set);
    }
    return { statement, order, actions, failures: [] };
  }

  private failRule(statement: Statement, code: FailureCode, reason: string): void {
    this.failures.push({ code, ruleId: statement.id, reason, span: statement.span });
  }

  /** Records one failure of each code for the rule. */
  private ruleFailure(rule: Rule, code: FailureCode, reason: string): void {
    if (rule.failures.includes(code)) return;
    rule.failures.push(code);
    this.failRule(rule.statement, code, reason);
  }

  /** Checks that each http:request clause of a permit names a fixed host a gateway can carry. */
  private bindPermit(rule: Rule): void {
    const set = rule.actions.get("http:request");
    if (!set) return;
    const bindings = set.clauses.flatMap((clause) => this.binding(rule, clause) ?? []);
    if (set.clauses.length === 0 && set.dead.includes("intercepted")) {
      this.ruleFailure(
        rule,
        "PLAIN_HTTP_ONLY",
        "it allows only plain HTTP (intercepted == false); the gateway reaches a target only over HTTPS",
      );
    }
    const byHost = new Map<string, Binding[]>();
    for (const b of bindings) byHost.set(b.host, [...(byHost.get(b.host) ?? []), b]);
    for (const [host, held] of byHost) {
      if (held.every((b) => b.methods.length === 0)) {
        const names = [...new Set(held.flatMap((b) => b.unroutable))].join(", ");
        this.ruleFailure(
          rule,
          "METHOD_NOT_ROUTABLE",
          `it allows only ${names} on ${host}; the gateway routes only GET, POST, and DELETE to a passthrough target`,
        );
      }
    }
  }

  private binding(rule: Rule, clause: Clause): Binding | undefined {
    const atoms = (field: FieldAtom["field"]) => clause.fields.filter((a) => a.field === field);
    const hostAtoms = atoms("host");
    const host = pinnedValue(hostAtoms, "host");
    if (typeof host !== "string") {
      const pattern = hostAtoms.find((a) => !a.negated && a.comparison.op === "like");
      if (pattern) {
        this.ruleFailure(
          rule,
          "WILDCARD_HOST",
          `it allows hosts by the pattern ${pattern.text}; a gateway target needs one fixed host, so name each host`,
        );
      } else {
        this.ruleFailure(
          rule,
          "UNCONSTRAINED_HOST",
          hostAtoms.length > 0
            ? `it allows every host except those it excludes (${hostAtoms.map((a) => a.text).join(", ")}); a gateway target needs one fixed host`
            : "it allows requests to every host; a gateway target needs one fixed host",
        );
      }
      return undefined;
    }
    if (!hostAtoms.every((a) => holds(a, host)) || this.mcpHosts.has(host)) return undefined;
    const problem = targetHostProblem(host);
    if (problem !== undefined) {
      this.ruleFailure(rule, "INVALID_HOST", `it allows ${problem}`);
      return undefined;
    }
    const portAtoms = atoms("port");
    const port = pinnedValue(portAtoms, "port");
    if (typeof port === "number") {
      if (!portAtoms.every((a) => holds(a, port))) return undefined;
      if (port === 80) {
        this.ruleFailure(
          rule,
          "PLAIN_HTTP_ONLY",
          `it allows ${host}:80, which is plain HTTP; the gateway reaches a target only over HTTPS`,
        );
        return undefined;
      }
    }
    const key = hostKey(host, typeof port === "number" ? port : 443);
    const blockedBy = this.blocked.get(key);
    if (blockedBy !== undefined) {
      this.ruleFailure(
        rule,
        "EGRESS_ENTRY_FAILED",
        `it allows ${key}, whose [egress.${blockedBy}] entry cannot convert`,
      );
      return undefined;
    }

    const methodAtoms = atoms("method");
    const named = pinnedValue(methodAtoms, "method");
    const candidates = typeof named === "string" ? [named] : HTTP_METHODS;
    const allowed = candidates.filter((m) => methodAtoms.every((a) => holds(a, m)));
    if (allowed.length === 0) return undefined;
    return {
      host,
      methods: ROUTABLE_METHODS.filter((m) => allowed.includes(m)),
      unroutable: allowed.filter((m) => !(ROUTABLE_METHODS as readonly string[]).includes(m)),
    };
  }
}

/** One `http:request` permit clause with a fixed host, and the methods it allows there. */
interface Binding {
  readonly host: string;
  readonly methods: readonly RoutableMethod[];
  readonly unroutable: readonly string[];
}

/** The clauses of the rules that convert, which decide each node. */
function livePolicy(rules: readonly Rule[]): Policy {
  const clauses = (effect: "permit" | "forbid", action: NetworkAction) =>
    rules
      .filter((r) => r.failures.length === 0 && r.statement.effect === effect)
      .flatMap((rule) =>
        (rule.actions.get(action)?.clauses ?? []).map((clause) => ({
          ruleId: rule.statement.id,
          order: rule.order,
          clause,
        })),
      );
  return {
    requestPermits: clauses("permit", "http:request"),
    requestForbids: clauses("forbid", "http:request"),
    connectPermits: clauses("permit", "net:connect"),
    connectForbids: clauses("forbid", "net:connect"),
  };
}

/**
 * Evaluates the whole Box policy on each sample request to the node. Box allows a request when
 * a `net:connect` permit and an `http:request` permit hold, and no forbid of either holds. A
 * condition the converter cannot read could hold in a permit, and does not hold in a forbid.
 */
function decide(node: Node, policy: Policy): MappedHost {
  const connectForbid = policy.connectForbids.find((c) => definite(c.clause, node));
  const connectPermit = policy.connectPermits.find((c) => possible(c.clause, node));
  const samples = sampleRequests(node, [...policy.requestPermits, ...policy.requestForbids]);
  const allowed: HostDecision["allowed"][number][] = [];
  const forbiddenBy = new Map<string, number>();
  const enforced = new Map<string, number>();
  for (const c of policy.connectForbids) {
    if (c !== connectForbid && possible(c.clause, node)) enforced.set(c.ruleId, c.order);
  }
  for (const sample of samples) {
    const permits = policy.requestPermits.filter((c) => possible(c.clause, node, sample));
    if (permits.length === 0) continue;
    if (connectForbid) {
      forbiddenBy.set(connectForbid.ruleId, connectForbid.order);
      continue;
    }
    if (!connectPermit) continue;
    const forbid = policy.requestForbids.find((c) => definite(c.clause, node, sample));
    if (forbid) {
      forbiddenBy.set(forbid.ruleId, forbid.order);
      continue;
    }
    allowed.push({ ...sample, ruleId: permits[0]!.ruleId });
    for (const p of permits) if (limits(p.clause)) enforced.set(p.ruleId, p.order);
    for (const f of policy.requestForbids) {
      if (possible(f.clause, node, sample)) enforced.set(f.ruleId, f.order);
    }
  }
  for (const [ruleId, order] of forbiddenBy) enforced.set(ruleId, order);
  for (const ruleId of BOX_CLI_BUILT_INS) enforced.delete(ruleId);
  const inOrder = (rules: Map<string, number>) =>
    [...rules].sort(([, a], [, b]) => a - b).map(([ruleId]) => ruleId);
  return {
    host: node.host,
    port: node.port,
    authority: hostKey(node.host, node.port),
    ...(node.entry && { entry: node.entry }),
    namedBy: node.namedBy,
    decision: { samples: samples.length, allowed },
    forbiddenBy: inOrder(forbiddenBy),
    enforcedByBox: inOrder(enforced),
    reachable: allowed.length > 0,
  };
}

/** Whether a permit clause allows only some requests to its host: by method, path, or more. */
function limits(clause: Clause): boolean {
  return (
    clause.opaque.length > 0 ||
    clause.fields.some((atom) => atom.field === "method" || atom.field === "path")
  );
}

/**
 * The value of a request field on a sample request to the node: `undefined` when the converter
 * cannot know it, and `null` when the request has no such field. A node's address is known only
 * when its host is an address.
 */
function fieldValue(
  atom: FieldAtom,
  node: Pick<Node, "host" | "port">,
  sample?: SampleRequest,
): string | number | null | undefined {
  const ip = isIP(node.host);
  switch (atom.field) {
    case "host":
      return node.host;
    case "port":
      return node.port;
    case "method":
      return sample?.method;
    case "path":
      return sample?.path;
    case "ip4":
      return ip === 4 ? node.host : ip === 6 ? null : undefined;
    case "ip6":
      return ip === 6 ? node.host : ip === 4 ? null : undefined;
  }
}

/** Whether a permit clause could hold: a value or a condition the converter cannot read could. */
function possible(clause: Clause, node: Pick<Node, "host" | "port">, sample?: SampleRequest) {
  return clause.fields.every((atom) => {
    const value = fieldValue(atom, node, sample);
    return value === undefined || holds(atom, value);
  });
}

/** Whether a forbid clause surely holds: a value or a condition the converter cannot read may not. */
function definite(clause: Clause, node: Pick<Node, "host" | "port">, sample?: SampleRequest) {
  return (
    clause.opaque.length === 0 &&
    clause.fields.every((atom) => {
      const value = fieldValue(atom, node, sample);
      return value !== undefined && holds(atom, value);
    })
  );
}

/** 4 for an IPv4 address, 6 for an IPv6 address, and 0 for a name. */
function isIP(host: string): 0 | 4 | 6 {
  if (/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(host)) return 4;
  return host.includes(":") ? 6 : 0;
}

/** Whether the clause's host and port tests hold for the node. */
function onHost(clause: Clause, node: Pick<Node, "host" | "port">): boolean {
  return clause.fields.every(
    (a) =>
      (a.field !== "host" || holds(a, node.host)) && (a.field !== "port" || holds(a, node.port)),
  );
}

/**
 * The sample requests the converter evaluates on a node: each routable method, on `/`, on each
 * literal path and each pattern's literal prefix that a clause for the host names, on the pattern
 * itself with each `*` as {@link SENTINEL_SEGMENT}, and on a sentinel segment below each.
 */
export function sampleRequests(
  node: Pick<Node, "host" | "port">,
  clauses: readonly Pick<RuleClause, "clause">[],
): SampleRequest[] {
  const paths = new Set<string>(["/", `/${SENTINEL_SEGMENT}`]);
  const below = (path: string) =>
    path.endsWith("/") ? `${path}${SENTINEL_SEGMENT}` : `${path}/${SENTINEL_SEGMENT}`;
  const rooted = (path: string) => (path.startsWith("/") ? path : `/${path}`);
  for (const { clause } of clauses) {
    if (!onHost(clause, node)) continue;
    for (const atom of clause.fields) {
      if (atom.field !== "path") continue;
      const comparison = atom.comparison;
      if (comparison.op === "like") {
        const parts = comparison.pattern.parts;
        const firstWildcard = parts.findIndex((p) => p.kind === "wildcard");
        const prefix = parts
          .slice(0, firstWildcard === -1 ? parts.length : firstWildcard)
          .map((p) => (p.kind === "literal" ? p.text : ""))
          .join("");
        const instance = rooted(
          parts.map((p) => (p.kind === "literal" ? p.text : SENTINEL_SEGMENT)).join(""),
        );
        if (prefix.startsWith("/")) {
          paths.add(prefix);
          paths.add(`${prefix}${SENTINEL_SEGMENT}`);
        }
        paths.add(instance);
        paths.add(below(instance));
      } else if (
        comparison.op !== "present" &&
        typeof comparison.value === "string" &&
        comparison.value.startsWith("/")
      ) {
        paths.add(comparison.value);
        paths.add(below(comparison.value));
      }
    }
  }
  return ROUTABLE_METHODS.flatMap((method) => [...paths].map((path) => ({ method, path })));
}

/** What keeps an entry from routing to gateway targets. */
function entryProblems(
  entry: {
    readonly protocol?: string;
    readonly backends?: readonly unknown[];
    readonly secret?: unknown;
  },
  destinations: readonly { text: string; parsed?: Destination }[],
): { code: FailureCode; reason: string }[] {
  const problems: { code: FailureCode; reason: string }[] = [];
  for (const d of destinations) {
    if (!d.parsed)
      problems.push({
        code: "INVALID_INPUT",
        reason: `its destination ${JSON.stringify(d.text)} is not host[:port][/path]`,
      });
  }
  if (entry.protocol === "mcp") {
    problems.push({
      code: "MCP_OVER_HTTP",
      reason:
        "it is an MCP server; Box cannot route an MCP server through a gateway backend, so the gateway cannot carry it",
    });
  }
  if ((entry.backends?.length ?? 0) > 0) {
    problems.push({
      code: "EGRESS_HAS_BACKEND",
      reason: "it already routes to a backend; convert the source profile, not the Runtime profile",
    });
  }
  for (const d of destinations) {
    if (d.parsed?.wildcard) {
      problems.push({
        code: "EGRESS_WILDCARD_DESTINATION",
        reason: `its destination ${d.text} is a wildcard; a gateway target needs one fixed host, so name each host`,
      });
      continue;
    }
    const problem = d.parsed && targetHostProblem(d.parsed.host);
    if (problem !== undefined) {
      problems.push({ code: "INVALID_HOST", reason: `its destination ${d.text} names ${problem}` });
    } else if (d.parsed?.port === 80) {
      problems.push({
        code: "PLAIN_HTTP_ONLY",
        reason: `its destination ${d.text} is plain HTTP; the gateway reaches a target only over HTTPS`,
      });
    }
  }
  const scoped = destinations.find((d) => d.parsed?.path !== undefined);
  if (entry.secret && scoped) {
    problems.push({
      code: "PATH_SCOPED_SECRET",
      reason:
        `its secret applies only under ${scoped.parsed!.path}, but a gateway target sends its ` +
        "credential on every path of the host",
    });
  }
  return problems;
}
