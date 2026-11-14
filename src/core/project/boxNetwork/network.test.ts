import { describe, expect, test } from "bun:test";
import {
  getBoxGatewayAgentCoreTargetSpec,
  getBoxGatewayBedrockEntry,
} from "../../../handlers/project/shortcuts";
import type { AgentCoreGatewayTarget } from "../../../projectSchemas/gateway";
import type { ProjectSpec } from "../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { boxGatewayIamWarnings, buildBoxNetwork } from "./network";
import { parsePolicyFiles } from "./policyParser";

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
/** A permit of the connection and of each request to a host that only the policy names. */
const reach = (id: string, host: string, rest = "") =>
  connect(`${id}_connect`, on(host)) + permit(id, on(host, rest));

const RUNTIME = { name: "agent", build: "CodeZip", entrypoint: "start.py" } as ProjectRuntime;
const passthrough = (name: string, endpoint: string, rest: Partial<AgentCoreGatewayTarget> = {}) =>
  ({
    name,
    targetType: "passthrough",
    passthrough: { endpoint, protocolType: "CUSTOM" },
    ...rest,
  }) as AgentCoreGatewayTarget;

interface Options {
  readonly mcp?: Record<string, unknown>;
  readonly targets?: AgentCoreGatewayTarget[];
  readonly credentials?: ProjectSpec["credentials"];
  readonly grantedActions?: string[];
  readonly executionRoleArn?: string;
}

/** The model of runtime `agent` for `policy` in `.box/policy.dw` and the profile's `egress`. */
function model(policy: string, egress: Record<string, unknown> = {}, options: Options = {}) {
  const spec = {
    name: "demo",
    projectType: "box",
    runtimes: [RUNTIME],
    memories: [],
    credentials: options.credentials ?? [],
    agentCoreGateways: options.targets
      ? [
          {
            ...getBoxGatewayBedrockEntry("agent"),
            targets: options.targets,
            ...(options.executionRoleArn && { executionRoleArn: options.executionRoleArn }),
          },
        ]
      : [],
  } as unknown as ProjectSpec;
  const { parsed, failures } = parsePolicyFiles(
    { egress, mcp: options.mcp ?? {}, policyFiles: policy ? ["policy.dw"] : [] },
    policy ? [{ file: ".box/policy.dw", text: policy }] : [],
  );
  const network = buildBoxNetwork(parsed, failures, {
    spec,
    runtime: RUNTIME,
    gateway: "agent-box",
    targets: options.targets ?? [],
    grantedActions: options.grantedActions ?? [],
  });
  return {
    spec,
    network,
    /** Each host as `authority -> target`, with `(none)` for a host with no target. */
    targets: () => network.hosts.map((h) => `${h.authority} -> ${h.target ?? "(none)"}`),
    host: (key: string) => network.hosts.find(({ authority }) => authority === key),
    failures: () =>
      network.failures.map((f) => [f.code, f.ruleId ?? f.egressEntry ?? f.mcpEntry ?? f.target]),
    reasons: () => network.failures.map((f) => f.reason),
  };
}

const GITHUB = { destinations: ["api.github.com"], secret: { ref: "env://GITHUB_TOKEN" } };
const GITHUB_KEY = {
  type: "API_KEY",
  credentialName: "github",
  location: "HEADER",
  parameterName: "Authorization",
  prefix: "Bearer",
} as const;

describe("the hosts of the model", () => {
  test("gives each host of an entry with several destinations its own target and auth", () => {
    const r = model("", {
      models: {
        destinations: [
          "bedrock-runtime.us-west-2.amazonaws.com",
          "bedrock-runtime.us-east-1.amazonaws.com",
        ],
        secret: { ref: "aws://default" },
      },
    });
    expect(r.targets()).toEqual([
      "bedrock-runtime.us-west-2.amazonaws.com -> egress-models-bedrock-runtime-us-west-2-amazonaws-com",
      "bedrock-runtime.us-east-1.amazonaws.com -> egress-models-bedrock-runtime-us-east-1-amazonaws-com",
    ]);
    expect(r.network.hosts.map((h) => h.outboundAuth)).toEqual([
      { kind: "iam", service: "bedrock", region: "us-west-2" },
      { kind: "iam", service: "bedrock", region: "us-east-1" },
    ]);
  });

  test("names a one-host entry's target after the entry", () => {
    expect(model("", { github: GITHUB }).host("api.github.com")).toMatchObject({
      target: "egress-github",
      outboundAuth: {
        kind: "apiKey",
        credentialName: "github",
        variable: "GITHUB_TOKEN",
        header: "Authorization",
        prefix: "Bearer",
      },
      sources: [
        { kind: "entry", egressEntry: "github", destinations: ["api.github.com"] },
        { kind: "rule", ruleId: "route_github_connect" },
        { kind: "rule", ruleId: "route_github_request" },
      ],
    });
  });

  test("gives a host only the policy names a target with no outbound auth", () => {
    const r = model(reach("httpbin", "httpbin.org", 'context.input.path == "/get"'));
    expect(r.targets()).toEqual(["httpbin.org -> egress-httpbin-org"]);
    expect(r.host("httpbin.org")).toMatchObject({ outboundAuth: { kind: "none" }, allowed: 3 });
  });

  test("gives no target to a host whose connection no rule permits", () => {
    expect(model(permit("httpbin", on("httpbin.org"))).targets()).toEqual([
      "httpbin.org -> (none)",
    ]);
  });

  test("keys a host by its port, with :443 as the port-less host", () => {
    const r = model(reach("pinned", "api.example.com", "context.input.port == 443"), {
      api: {
        destinations: ["api.example.com/v1", "api.example.com:443/v2", "api.example.com:8443"],
      },
    });
    expect(r.targets()).toEqual([
      "api.example.com -> egress-api-api-example-com",
      "api.example.com:8443 -> egress-api-api-example-com-8443",
    ]);
    expect(r.host("api.example.com:8443")?.port).toBe(8443);
    expect(r.host("api.example.com")?.port).toBeUndefined();
  });
});

describe("the gateway's targets", () => {
  test("takes the gateway's target for a host by its host and port, not by its name", () => {
    const r = model(
      reach("weather", "weather.example.com"),
      {
        bedrock: {
          destinations: ["bedrock-runtime.us-west-2.amazonaws.com"],
          secret: { ref: "aws://default" },
        },
        github: GITHUB,
      },
      {
        targets: [
          passthrough("model", "https://bedrock-runtime.us-west-2.amazonaws.com", {
            outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "bedrock", region: "us-west-2" },
          }),
          passthrough("gh", "https://api.github.com:443", { outboundAuth: GITHUB_KEY }),
          passthrough("egress-forecast", "https://weather.example.com"),
        ],
        credentials: [{ authorizerType: "ApiKeyCredentialProvider", name: "github" }],
      },
    );
    expect(r.targets()).toEqual([
      "bedrock-runtime.us-west-2.amazonaws.com -> model",
      "api.github.com -> gh",
      "weather.example.com -> egress-forecast",
    ]);
    expect(r.failures()).toEqual([]);
  });

  test("refuses a target build does not manage whose outbound auth differs from the entry's", () => {
    const r = model(
      "",
      { github: GITHUB },
      {
        targets: [
          passthrough("gh", "https://api.github.com", {
            outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "execute-api", region: "us-east-1" },
          }),
        ],
      },
    );
    expect(r.failures()).toEqual([["EXISTING_TARGET_CONFLICT", "github"]]);
    expect(r.reasons()[0]).toBe(
      "[egress.github]: the Box gateway's target gh sends GATEWAY_IAM_ROLE (execute-api, us-east-1) to api.github.com, and [egress.github] gives it API_KEY (github, header Authorization, prefix Bearer); one host has one target. Make the two the same, in agentcore.json or in .box/profile.toml",
    );
  });

  test("keeps the outbound auth of a target for a host that only the policy names", () => {
    const r = model(
      reach("w", "weather.example.com"),
      {},
      {
        targets: [
          passthrough("weather", "https://weather.example.com", {
            outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "execute-api", region: "us-east-1" },
          }),
        ],
      },
    );
    expect(r.targets()).toEqual(["weather.example.com -> weather"]);
    expect(r.failures()).toEqual([]);
  });

  test("refuses a target that sends a host's requests under a path, or that is not CUSTOM", () => {
    const pathed = model(
      reach("w", "weather.example.com"),
      {},
      {
        targets: [passthrough("weather", "https://weather.example.com/v1")],
      },
    );
    expect(pathed.failures()).toEqual([["EXISTING_TARGET_CONFLICT", "w_connect"]]);
    expect(pathed.network.failures[0]?.place).toBe(".box/policy.dw:1:1");
  });

  test("refuses to manage an egress- target that build would not write, and names it", () => {
    const r = model(
      "",
      { github: GITHUB },
      {
        targets: [
          passthrough("egress-github", "https://api.github.com", {
            passthrough: { endpoint: "https://api.github.com", protocolType: "MCP" },
          }),
          passthrough("egress-old", "https://old.example.com", {
            outboundAuth: {
              type: "API_KEY",
              credentialName: "old",
              location: "QUERY_PARAMETER",
              parameterName: "key",
            },
          }),
        ],
      },
    );
    expect(r.failures()).toEqual([
      ["MANAGED_TARGET_CHANGED", "egress-github"],
      ["MANAGED_TARGET_CHANGED", "egress-old"],
    ]);
    expect(r.reasons()[0]).toContain("has protocolType MCP, which build does not write");
  });

  test("lets a new host take the name of an egress- target that no host takes now", () => {
    const r = model(
      "",
      { github: GITHUB },
      {
        targets: [passthrough("egress-github", "https://old.example.com")],
      },
    );
    expect(r.targets()).toEqual(["api.github.com -> egress-github"]);
    expect(r.failures()).toEqual([]);
  });

  test("refuses a new name that a target build does not manage holds", () => {
    const r = model(
      "",
      { github: GITHUB, "egress-x": { destinations: ["x.example.com"] } },
      {
        targets: [passthrough("egress-egress-x-taken", "https://unused.example.com")],
      },
    );
    expect(r.failures()).toEqual([]);
    const taken = model(
      "",
      { mine: { destinations: ["a.example.com"] } },
      {
        targets: [passthrough("user-target", "https://b.example.com")],
      },
    );
    expect(taken.failures()).toEqual([]);
  });

  test("fails two entries that give one target name", () => {
    const r = model("", {
      my_api: { destinations: ["a.example.com"] },
      "my-api": { destinations: ["b.example.com"] },
    });
    expect(r.failures()).toEqual([["TARGET_NAME_COLLISION", "my-api"]]);
  });

  test("fails a host only the policy names whose name an entry holds", () => {
    const r = model(reach("gh", "api.github.com"), {
      "api-github-com": { destinations: ["other.example.com"] },
    });
    expect(r.failures()).toEqual([["TARGET_NAME_COLLISION", "gh_connect"]]);
  });

  test("gives a reserved-looking entry a name that takes none of the gateway's own paths", () => {
    for (const entry of ["mcp", "a2a", "responses", "converse", "MCP"]) {
      expect(
        model("", { [entry]: { destinations: ["a.example.com"] } }).host("a.example.com")?.target,
      ).toBe(`egress-${entry}`);
    }
  });

  test("caps a target name at 100 characters, its prefix included, and fails a nameless one", () => {
    expect(
      model("", { ["x".repeat(120)]: { destinations: ["a.example.com"] } }).host("a.example.com")
        ?.target,
    ).toBe(`egress-${"x".repeat(93)}`);
    expect(model("", { ___: { destinations: ["a.example.com"] } }).failures()).toEqual([
      ["TARGET_NAME_INVALID", "___"],
    ]);
  });

  test("fails more than 100 targets, counting the targets the gateway keeps", () => {
    const egress = Object.fromEntries(
      Array.from({ length: 99 }, (_, i) => [`h${i}`, { destinations: [`h${i}.example.com`] }]),
    );
    expect(
      model("", egress, { targets: [passthrough("mine", "https://mine.example.com")] }).failures(),
    ).toEqual([]);
    const r = model("", egress, {
      targets: [
        passthrough("mine", "https://mine.example.com"),
        passthrough("bedrock", "https://b.example.com"),
      ],
    });
    expect(r.failures()).toEqual([["TOO_MANY_TARGETS", undefined]]);
  });
});

describe("outbound auth", () => {
  test("signs an AWS endpoint for its service and region, a China one too", () => {
    const auth = (host: string) =>
      model("", { x: { destinations: [host], secret: { ref: "aws://default" } } }).host(host)
        ?.outboundAuth;
    expect(auth("bedrock-agentcore.eu-west-1.amazonaws.com")).toEqual({
      kind: "iam",
      service: "bedrock-agentcore",
      region: "eu-west-1",
    });
    expect(auth("bedrock-runtime.cn-north-1.amazonaws.com.cn")).toEqual({
      kind: "iam",
      service: "bedrock",
      region: "cn-north-1",
    });
  });

  test("names the API key credential that covers the variable, else the entry's own", () => {
    const covering = model(
      "",
      {
        openai: {
          destinations: ["api.openai.com"],
          secret: { ref: "env://AGENTCORE_CREDENTIAL_AGENTOPENAIAPIKEY" },
        },
      },
      {
        credentials: [{ authorizerType: "ApiKeyCredentialProvider", name: "agentOpenAIApiKey" }],
      },
    );
    expect(covering.host("api.openai.com")?.outboundAuth).toMatchObject({
      credentialName: "agentOpenAIApiKey",
    });
    expect(covering.network.credentials).toEqual([
      { name: "agentOpenAIApiKey", variable: "AGENTCORE_CREDENTIAL_AGENTOPENAIAPIKEY" },
    ]);
    expect(model("", { github: GITHUB }).network.credentials).toEqual([
      { name: "github", variable: "GITHUB_TOKEN" },
    ]);
  });

  test("fails an env:// entry whose name cannot name a credential, or whose name another kind holds", () => {
    expect(
      model("", {
        ab: { destinations: ["a.example.com"], secret: { ref: "env://KEY" } },
      }).failures(),
    ).toEqual([["API_KEY_CREDENTIAL_MISSING", "ab"]]);
    const taken = model(
      "",
      { github: GITHUB },
      { credentials: [{ authorizerType: "OAuthCredentialProvider", name: "github" } as never] },
    );
    expect(taken.failures()).toEqual([["API_KEY_CREDENTIAL_MISSING", "github"]]);
  });

  test("refuses a secret the gateway cannot send", () => {
    const failures = (destination: string, secret: Record<string, unknown>) =>
      model("", { x: { destinations: [destination], secret } }).failures();
    expect(failures("api.example.com", { ref: "credsd://prod" })).toEqual([
      ["UNSUPPORTED_SECRET", "x"],
    ]);
    expect(failures("api.example.com", { ref: "vault://kv" })).toEqual([
      ["UNSUPPORTED_SECRET", "x"],
    ]);
    expect(
      failures("api.example.com", { ref: "env://KEY", placement: "query_param", param: "key" }),
    ).toEqual([["UNSUPPORTED_SECRET_PLACEMENT", "x"]]);
    expect(failures("api.example.com", { ref: "aws://default" })).toEqual([
      ["UNSIGNABLE_HOST", "x"],
    ]);
    expect(failures("api.example.com/v1", { ref: "env://KEY" })).toEqual([
      ["PATH_SCOPED_SECRET", "x"],
    ]);
  });
});

describe("hosts the model cannot carry", () => {
  test("fails a wildcard host, a permit with no fixed host, and a wildcard destination, once each", () => {
    const r = model(
      permit("wild", 'context.input.host like "*.example.com"') +
        rule("anywhere", `permit (principal, ${HR}, resource);`) +
        permit("not_one", 'context.input.host != "evil.example.com"'),
      { wide: { destinations: ["*.example.com"] } },
    );
    expect(r.failures()).toEqual([
      ["EGRESS_WILDCARD_DESTINATION", "wide"],
      ["WILDCARD_HOST", "wild"],
      ["UNCONSTRAINED_HOST", "anywhere"],
      ["UNCONSTRAINED_HOST", "not_one"],
    ]);
    expect(r.network.failures[1]?.place).toBe(".box/policy.dw:1:1");
  });

  test("fails a host reachable only over plain HTTP", () => {
    expect(
      model(
        permit("plain", on("a.example.com", "context.input.intercepted == false")) +
          permit("port80", on("b.example.com", "context.input.port == 80")),
        { http: { destinations: ["c.example.com:80"] } },
      ).failures(),
    ).toEqual([
      ["PLAIN_HTTP_ONLY", "http"],
      ["PLAIN_HTTP_ONLY", "plain"],
      ["PLAIN_HTTP_ONLY", "port80"],
    ]);
  });

  test("fails a rule that allows only PUT, PATCH, or HEAD, and keeps the routable methods", () => {
    const r = model(
      permit("put", on("a.example.com", '["PUT", "PATCH", "HEAD"].contains(context.input.method)')),
    );
    expect(r.failures()).toEqual([["METHOD_NOT_ROUTABLE", "put"]]);
    const mixed = model(
      reach("both", "a.example.com", '["GET", "PUT"].contains(context.input.method)'),
    );
    expect(mixed.targets()).toEqual(["a.example.com -> egress-a-example-com"]);
  });

  test("fails a permit of the user's on the host of an entry that cannot convert", () => {
    const r = model(permit("x_get", on("a.example.com")), {
      x: { destinations: ["a.example.com"], backends: [{ url: "https://gw.example.com/x" }] },
    });
    expect(r.failures()).toEqual([
      ["EGRESS_HAS_BACKEND", "x"],
      ["EGRESS_ENTRY_FAILED", "x_get"],
    ]);
  });

  test("fails an MCP server over HTTP at its [mcp] entry, and an [egress] entry that is one", () => {
    const r = model(
      permit("tools", on("tools.example.com")),
      { m: { destinations: ["mcp.example.com"], protocol: "mcp" } },
      {
        mcp: { tools: { type: "http", destinations: ["tools.example.com"] } },
      },
    );
    expect(r.failures()).toEqual([
      ["MCP_OVER_HTTP", "m"],
      ["MCP_OVER_HTTP", "tools"],
    ]);
    expect(r.reasons()[1]).toBe(
      "[mcp.tools]: it is an MCP server over HTTP, and Box cannot route an MCP server through a gateway backend",
    );
  });

  test("refuses a host Box never presents, at its rule or its entry", () => {
    const r = model(
      permit("upper", 'context.input.host == "API.example.com"') +
        forbid("dot", 'context.input.host == "x.example.com."'),
      {
        caps: { destinations: ["Api.example.com"] },
        under: { destinations: ["my_host.example.com"] },
        six: { destinations: ["[::1]:8443"] },
      },
    );
    expect(r.failures()).toEqual([
      ["INVALID_HOST", "caps"],
      ["INVALID_HOST", "under"],
      ["INVALID_HOST", "six"],
      ["INVALID_HOST", "upper"],
      ["INVALID_HOST", "dot"],
    ]);
    expect(r.reasons()[2]).toContain("is an IPv6 address");
  });

  test("fails rules Box would refuse, and a syntax error at its place", () => {
    const r = model(
      rule("dup", `permit (principal, ${HR}, resource) when { ${on("a.example.com")} };`) +
        rule("dup", `permit (principal, ${HR}, resource) when { ${on("b.example.com")} };`) +
        rule("verb", 'permit (principal, action == Box::Action::"http:get", resource);') +
        permit("query", on("a.example.com", 'context.input.query == "x"')) +
        "permit (principal, action, resource) when { context.input.host == };\n",
    );
    expect(r.failures()).toEqual([
      ["PARSE_ERROR", undefined],
      ["DUPLICATE_RULE_ID", "dup"],
      ["UNKNOWN_ACTION", "verb"],
      ["UNKNOWN_ATTRIBUTE", "query"],
    ]);
    expect(r.network.failures[0]?.place).toBe(".box/policy.dw:5:67");
  });
});

describe("the default targets", () => {
  test("gives the Memory endpoint to the agentcore target build adds, and no egress- target", () => {
    const r = model(
      "",
      {
        memory: {
          destinations: ["bedrock-agentcore.us-west-2.amazonaws.com"],
          secret: { ref: "aws://default" },
        },
      },
      { targets: [getBoxGatewayAgentCoreTargetSpec()] },
    );
    expect(r.targets()).toEqual(["bedrock-agentcore.us-west-2.amazonaws.com -> agentcore"]);
    expect(r.failures()).toEqual([]);
  });

  test("refuses an entry for a default target's endpoint whose secret differs", () => {
    const r = model(
      "",
      {
        memory: {
          destinations: ["bedrock-agentcore.us-west-2.amazonaws.com"],
          secret: { ref: "env://KEY" },
        },
      },
      { targets: [getBoxGatewayAgentCoreTargetSpec()] },
    );
    expect(r.failures()).toEqual([["EXISTING_TARGET_CONFLICT", "memory"]]);
  });
});

describe("warnings", () => {
  test("names the rules Box enforces alone, and the Runtime route of a host only the policy names", () => {
    const r = model(
      reach("get", "httpbin.org", 'context.input.method == "GET"') +
        forbid("no_admin", on("api.github.com", 'context.input.path like "/admin/*"')),
      { github: GITHUB },
    );
    expect(r.network.warnings).toEqual([
      `api.github.com (target 'egress-github' of gateway 'agent-box'): the gateway forwards every request to it, and Box enforces "no_admin" on its own; Box allows 6 of 15 sample requests`,
      `httpbin.org (target 'egress-httpbin-org' of gateway 'agent-box'): the gateway forwards every request to it, and Box enforces "get" on its own; Box allows 2 of 6 sample requests. The AgentCore Runtime route for httpbin.org permits every request to it, so there Box enforces the forbids, and not the method and path limits of the permits`,
    ]);
  });

  test("names an entry whose host gets no target, and the forbids that deny it", () => {
    expect(
      model(forbid("no_github", on("api.github.com")), { github: GITHUB }).network.warnings,
    ).toEqual([
      `[egress.github] api.github.com gets no target of gateway 'agent-box': Box allows no request to it, and "no_github" forbid it`,
    ]);
  });

  test("names each target the gateway signs for a service that no policy of its role grants", () => {
    const egress = {
      control: {
        destinations: ["bedrock.us-west-2.amazonaws.com"],
        secret: { ref: "aws://default" },
      },
    };
    const control = {
      ...getBoxGatewayBedrockEntry("agent").targets[0]!,
      name: "egress-control",
      passthrough: { endpoint: "https://bedrock.us-west-2.amazonaws.com", protocolType: "CUSTOM" },
    } as AgentCoreGatewayTarget;
    const memory = getBoxGatewayAgentCoreTargetSpec();
    const r = model("", egress, {
      targets: [...getBoxGatewayBedrockEntry("agent").targets, control, memory],
    });
    r.spec.agentCoreGateways[0]!.additionalPolicies = ["agentcore/box-memory-policy.json"];
    expect(boxGatewayIamWarnings(r.spec, r.network)).toEqual([
      "target 'bedrock' of gateway 'agent-box' (agentcore create added it) signs its requests with the gateway's role for 'bedrock', and no policy of that role grants a 'bedrock:' action, so bedrock refuses them. Add an IAM policy file to additionalPolicies of agent-box.",
      "target 'egress-control' of gateway 'agent-box' signs its requests with the gateway's role for 'bedrock', and no policy of that role grants a 'bedrock:' action, so bedrock refuses them. Add an IAM policy file to additionalPolicies of agent-box.",
    ]);
    const granted = model("", egress, {
      targets: [control],
      grantedActions: ["bedrock:InvokeModel"],
    });
    expect(boxGatewayIamWarnings(granted.spec, granted.network)).toEqual([]);
    const listed = model("", egress, {
      targets: [...getBoxGatewayBedrockEntry("agent").targets, control],
    });
    listed.spec.agentCoreGateways[0]!.additionalPolicies = ["agentcore/box-bedrock-policy.json"];
    expect(boxGatewayIamWarnings(listed.spec, listed.network)).toEqual([]);
    const imported = model("", egress, {
      targets: [control],
      executionRoleArn: "arn:aws:iam::123456789012:role/mine",
    });
    expect(boxGatewayIamWarnings(imported.spec, imported.network)).toEqual([]);
  });
});
