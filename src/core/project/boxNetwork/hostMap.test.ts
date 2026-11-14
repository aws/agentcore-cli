import { describe, expect, test } from "bun:test";
import { parsePolicy } from "./dogwood";
import { buildHostMap } from "./hostMap";
import { boxGeneratedNetworkRules } from "./profileParser";

const HR = 'action == Box::Action::"http:request"';
const NC = 'action == Box::Action::"net:connect"';
const rule = (id: string, body: string) => `@id("${id}") ${body}\n`;
const permit = (id: string, condition: string) =>
  rule(id, `permit (principal, ${HR}, resource) when { ${condition} };`);
const forbid = (id: string, condition: string) =>
  rule(id, `forbid (principal, ${HR}, resource) when { ${condition} };`);
const connect = (id: string, condition: string) =>
  rule(id, `permit (principal, ${NC}, resource) when { ${condition} };`);
const on = (host: string, rest = "") =>
  `context.input.host == "${host}"${rest ? ` && ${rest}` : ""}`;
const reach = (id: string, host: string, rest = "") =>
  connect(`${id}_connect`, on(host)) + permit(id, on(host, rest));

/** The host map of `policy` and the rules the box CLI adds for `egress` and `mcp`, as build makes it. */
function map(
  policy: string,
  egress: Record<string, unknown> = {},
  mcp: Record<string, unknown> = {},
) {
  const parsed = parsePolicy(policy + boxGeneratedNetworkRules(egress, mcp));
  if (parsed.errors.length > 0) throw new Error(JSON.stringify(parsed.errors));
  return buildHostMap({ statements: parsed.statements, egress, mcp });
}
const host = (result: ReturnType<typeof map>, key: string) =>
  result.hosts.find(({ authority }) => authority === key);

describe("the policy decision on each host", () => {
  test("forbids the cloud metadata hosts and addresses with the box CLI's own rules", () => {
    const result = map("", {
      google: { destinations: ["metadata.google.internal"] },
      imds: { destinations: ["169.254.169.254"] },
      internal: { destinations: ["10.0.0.1"] },
    });
    expect(result.hosts.map(({ authority, reachable }) => [authority, reachable])).toEqual([
      ["metadata.google.internal", false],
      ["169.254.169.254", false],
      ["10.0.0.1", true],
    ]);
    expect(host(result, "169.254.169.254")?.forbiddenBy).toEqual(["metadata_addresses"]);
    expect(host(result, "metadata.google.internal")?.forbiddenBy).toEqual(["metadata_hosts"]);
  });

  test("names no box CLI rule among the rules Box enforces on its own", () => {
    expect(
      host(map("", { api: { destinations: ["api.example.com"] } }), "api.example.com")
        ?.enforcedByBox,
    ).toEqual([]);
  });

  test("evaluates a path pattern that starts with a wildcard", () => {
    const result = map(
      reach("json", "x.example.com", 'context.input.path like "*.json"') +
        reach("health", "y.example.com", 'context.input.path like "*/health"'),
    );
    expect(host(result, "x.example.com")?.reachable).toBe(true);
    expect(host(result, "x.example.com")?.decision.allowed.map((s) => s.path)).toContain("/§.json");
    expect(host(result, "y.example.com")?.reachable).toBe(true);
  });

  test("names the limited permits and the forbids Box enforces on its own, in policy order", () => {
    const result = map(
      forbid("no_admin", on("x.example.com", 'context.input.path like "/admin/*"')) +
        reach("get", "x.example.com", 'context.input.method == "GET"') +
        forbid("big", on("x.example.com", "context.input.body_bytes > 10")),
    );
    expect(host(result, "x.example.com")).toMatchObject({
      reachable: true,
      forbiddenBy: ["no_admin"],
      enforcedByBox: ["no_admin", "get", "big"],
    });
  });

  test("gives a host only to a permit: a forbid with a fixed host makes no node", () => {
    expect(map(forbid("no_x", on("x.example.com"))).hosts).toEqual([]);
  });

  test("leaves the rules of an entry that fails to it, so one cause is one failure", () => {
    const result = map("", { wide: { destinations: ["*.example.com"] } });
    expect(
      result.failures.map(({ code, egressEntry, ruleId }) => [code, egressEntry ?? ruleId]),
    ).toEqual([["EGRESS_WILDCARD_DESTINATION", "wide"]]);
  });

  test("fails an MCP server over HTTP at its [mcp] entry, once", () => {
    const result = map(
      permit("tools", on("tools.example.com")),
      {},
      { tools: { type: "http", destinations: ["tools.example.com"] } },
    );
    expect(result.failures.map(({ code, mcpEntry, ruleId }) => [code, mcpEntry ?? ruleId])).toEqual(
      [["MCP_OVER_HTTP", "tools"]],
    );
  });
});

/** A small random rule on one of two hosts, as the property test writes it. */
interface RandomRule {
  readonly effect: "permit" | "forbid";
  readonly action: "http" | "connect";
  readonly host?: string;
  readonly port?: number;
  readonly method?: string;
  readonly path?:
    | { readonly op: "=="; readonly value: string }
    | { readonly op: "like"; readonly prefix: string };
}

const RANDOM_HOSTS = ["a.example.com", "b.example.com"];
const RANDOM_PATHS: RandomRule["path"][] = [
  undefined,
  { op: "==", value: "/a" },
  { op: "like", prefix: "/a/" },
  { op: "like", prefix: "/b" },
];
/** Paths in every class the random rules tell apart, which the converter does not see. */
const CORPUS = ["/", "/a", "/a/", "/a/x", "/a/x/y", "/b", "/bx", "/b/x", "/c", "/c/d"];

/** A deterministic generator of numbers in [0, 1), so a failing seed reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRules(next: () => number): RandomRule[] {
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
  return Array.from({ length: 1 + Math.floor(next() * 6) }, () => {
    const effect = next() < 0.6 ? "permit" : "forbid";
    const action = next() < 0.75 ? "http" : "connect";
    // Each permit names a fixed host, or the converter refuses it; a forbid may name none.
    const host = effect === "permit" || next() < 0.7 ? pick(RANDOM_HOSTS) : undefined;
    const port = next() < 0.15 ? 8443 : undefined;
    if (action === "connect") return { effect, action, host, port };
    return {
      effect,
      action,
      host,
      port,
      method: pick([undefined, undefined, "GET", "POST", "DELETE"]),
      path: pick(RANDOM_PATHS),
    };
  });
}

function ruleText(r: RandomRule, i: number): string {
  const tests = [
    ...(r.host ? [`context.input.host == "${r.host}"`] : []),
    ...(r.port ? [`context.input.port == ${r.port}`] : []),
    ...(r.method ? [`context.input.method == "${r.method}"`] : []),
    ...(r.path?.op === "==" ? [`context.input.path == "${r.path.value}"`] : []),
    ...(r.path?.op === "like" ? [`context.input.path like "${r.path.prefix}*"`] : []),
  ];
  const action = r.action === "http" ? HR : NC;
  const when = tests.length > 0 ? ` when { ${tests.join(" && ")} }` : "";
  return rule(`r${i}`, `${r.effect} (principal, ${action}, resource)${when};`);
}

/** Box's decision on one request, read straight from the random rules. */
function boxAllows(
  rules: readonly RandomRule[],
  host: string,
  port: number,
  method: string,
  path: string,
) {
  const matches = (r: RandomRule) =>
    (r.host === undefined || r.host === host) &&
    (r.port === undefined || r.port === port) &&
    (r.method === undefined || r.method === method) &&
    (r.path === undefined ||
      (r.path.op === "==" ? path === r.path.value : path.startsWith(r.path.prefix)));
  const decides = (action: RandomRule["action"]) =>
    rules.some((r) => r.action === action && r.effect === "permit" && matches(r)) &&
    !rules.some((r) => r.action === action && r.effect === "forbid" && matches(r));
  return decides("connect") && decides("http");
}

describe("the host map, over random rule sets", () => {
  test("names every fixed host a permit names, and finds a host reachable iff Box allows a request to it", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rules = randomRules(random(seed));
      const result = map(rules.map(ruleText).join(""));
      if (result.failures.length > 0) {
        throw new Error(`seed ${seed}: ${JSON.stringify(result.failures)}`);
      }
      const keys = result.hosts.map(({ authority }) => authority);
      for (const r of rules) {
        if (r.effect !== "permit" || r.host === undefined) continue;
        const key = r.port ? `${r.host}:${r.port}` : r.host;
        expect({ seed, has: keys.includes(key) }).toEqual({ seed, has: true });
      }
      for (const node of result.hosts) {
        const allowed = ["GET", "POST", "DELETE"].some((method) =>
          CORPUS.some((path) => boxAllows(rules, node.host, node.port, method, path)),
        );
        expect({ seed, node: node.authority, target: node.reachable }).toEqual({
          seed,
          node: node.authority,
          target: allowed,
        });
      }
    }
  });
});
