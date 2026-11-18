import { describe, expect, test } from "bun:test";
import { getBoxGatewayAgentCoreTargetSpec } from "../../../handlers/project/shortcuts";
import { getBoxGatewayBedrockEntry } from "../../../handlers/project/box-gateway-test-support";
import type { AgentCoreGatewayTarget } from "../../../projectSchemas/gateway";
import type { ProjectSpec } from "../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { boxNetworkRules } from "../boxProfileResolver-test-support";
import { boxGatewayIamWarnings, buildBoxNetwork } from "./network";
import { parseResolvedPolicy } from "./policyParser";
import { profilePlaces } from "./profileParser";
import { thirdPartyTelemetry } from "./telemetry";

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
  /** Rules that only Box's policy holds, as a pack adds them. */
  readonly packRules?: string;
  /** Rules that only Box's policy holds, before the policy file's. */
  readonly boxFirst?: string;
  readonly targets?: AgentCoreGatewayTarget[];
  readonly credentials?: ProjectSpec["credentials"];
  readonly grantedActions?: string[];
  readonly executionRoleArn?: string;
  /** The `[telemetry]` tables, as Box resolves them. */
  readonly telemetry?: Record<string, unknown>;
  /** Whether the Runtime profile reads telemetry keys from AWS Secrets Manager. */
  readonly secretsManager?: boolean;
  /** Changes to runtime `agent`, a CodeZip runtime. */
  readonly runtime?: Partial<ProjectRuntime>;
}

/** The local box profile of runtime `agent`. */
const PROFILE = ".box/agent/local/profile.toml";

/**
 * The model of runtime `agent` for `policy` in `.box/agent/local/policy.dw` and the routes `egress`, as Box
 * resolves them: its policy holds the file, then the rules Box adds for each route. The profile
 * sets `packs` on line 1, then each entry of `egress` and `mcp` on a line of its own.
 */
function model(policy: string, egress: Record<string, unknown> = {}, options: Options = {}) {
  const runtime = { ...RUNTIME, ...options.runtime } as ProjectRuntime;
  const spec = {
    name: "demo",
    projectType: "box",
    runtimes: [runtime],
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
  const mcp = options.mcp ?? {};
  const profile = [
    'packs = ["box/base"]',
    ...Object.keys(egress).map((name) => `[egress.${JSON.stringify(name)}]`),
    ...Object.keys(mcp).map((name) => `[mcp.${JSON.stringify(name)}]`),
  ].join("\n");
  const telemetry = thirdPartyTelemetry({ telemetry: options.telemetry });
  const { parsed, failures } = parseResolvedPolicy(
    {
      path: PROFILE,
      egress,
      mcp,
      policyFiles: policy ? ["policy.dw"] : [],
      places: profilePlaces(profile, PROFILE),
      thirdPartyTelemetry: telemetry.targets,
      leftOutTelemetry: telemetry.leftOut,
    },
    `${options.boxFirst ?? ""}${policy}\n${options.packRules ?? ""}${boxNetworkRules(egress, mcp)}`,
    policy ? [{ file: ".box/agent/local/policy.dw", text: policy }] : [],
  );
  const network = buildBoxNetwork(parsed, failures, {
    spec,
    runtime,
    gateway: "agent-box",
    region: "us-west-2",
    targets: options.targets ?? [],
    grantedActions: options.grantedActions ?? [],
    secretsManager: options.secretsManager ?? false,
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
    /** Each failure as its place and its text, as the error prints it. */
    lines: () => network.failures.map((f) => `${f.place}  ${f.reason}`),
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
    expect(r.lines()).toEqual([
      "agentcore/agentcore.json  The gateway target 'gh' for api.github.com sends requests " +
        "signed with the gateway's role for execute-api, and [egress.github] sends the API key " +
        "credential 'github' in the header Authorization with the prefix Bearer. Make the two " +
        "the same, in agentcore.json or in .box/agent/local/profile.toml.",
    ]);
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
        targets: [
          passthrough("weather", "https://weather.example.com/v1"),
          passthrough("tools", "https://tools.example.com", {
            passthrough: { endpoint: "https://tools.example.com", protocolType: "MCP" },
          }),
        ],
      },
    );
    const tools = model(
      reach("t", "tools.example.com"),
      {},
      {
        targets: [
          passthrough("tools", "https://tools.example.com", {
            passthrough: { endpoint: "https://tools.example.com", protocolType: "MCP" },
          }),
        ],
      },
    );
    expect(pathed.failures()).toEqual([["EXISTING_TARGET_CONFLICT", "w_connect"]]);
    expect([...pathed.lines(), ...tools.lines()]).toEqual([
      "agentcore/agentcore.json  The gateway target 'weather' for weather.example.com has the " +
        "path /v1 in its endpoint, and the agent's requests do not include it. Remove /v1 from " +
        "the endpoint, or remove the target.",
      "agentcore/agentcore.json  The gateway target 'tools' for tools.example.com has " +
        "protocolType MCP, and Box needs CUSTOM. Set its protocolType to CUSTOM, or remove the " +
        "target.",
    ]);
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
    expect(r.lines()).toEqual([
      "agentcore/agentcore.json  The gateway target 'egress-github' has protocolType MCP, " +
        'which build does not write for a target whose name starts with "egress-", so build ' +
        'does not change or remove it. Rename it without "egress-" to keep it as yours, or ' +
        "remove it so build writes it again.",
      "agentcore/agentcore.json  The gateway target 'egress-old' sends the API key credential " +
        "'old' in the query parameter key, which build does not write for a target whose name " +
        'starts with "egress-", so build does not change or remove it. Rename it without ' +
        '"egress-" to keep it as yours, or remove it so build writes it again.',
    ]);
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
    expect(r.lines()).toEqual([
      ".box/agent/local/profile.toml:3:1  [egress.my-api] would name the gateway target for b.example.com " +
        "'egress-my-api', and [egress.my_api] for a.example.com has that name. Rename the entry.",
    ]);
  });

  test("fails a host only the policy names whose name an entry holds", () => {
    const r = model(reach("gh", "api.github.com"), {
      "api-github-com": { destinations: ["other.example.com"] },
    });
    expect(r.failures()).toEqual([["TARGET_NAME_COLLISION", "gh_connect"]]);
    expect(r.lines()).toEqual([
      '.box/agent/local/policy.dw:1:1  The rule "gh_connect" allows api.github.com, and its gateway target ' +
        "would have the name 'egress-api-github-com', which [egress.api-github-com] for " +
        "other.example.com has. Add an [egress] entry with another name for api.github.com.",
    ]);
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
    expect(model("", { ___: { destinations: ["a.example.com"] } }).lines()).toEqual([
      ".box/agent/local/profile.toml:2:1  [egress.___] has no letter or digit in its name, so build cannot " +
        "name a gateway target after it. Rename the entry.",
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
    expect(r.lines()).toEqual([
      ".box/agent/local/profile.toml  The gateway 'agent-box' needs 101 targets, 99 for the hosts of the " +
        "Box profile and 2 of your own, and a gateway can have at most 100. Remove hosts from " +
        "the profile, or targets from the gateway.",
    ]);
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
    expect(taken.lines()).toEqual([
      ".box/agent/local/profile.toml:2:1  [egress.github] needs an API key credential named 'github' for " +
        "env://GITHUB_TOKEN, and agentcore.json has a credential of another type with that " +
        "name. Rename the entry, or that credential.",
    ]);
    expect(
      model("", { ab: { destinations: ["a.example.com"], secret: { ref: "env://KEY" } } }).lines(),
    ).toEqual([
      ".box/agent/local/profile.toml:2:1  [egress.ab] needs an API key credential named after it for " +
        'env://KEY, and "ab" is not a valid credential name (3 to 128 letters, digits, "-", ' +
        'or "_"). Rename the entry.',
    ]);
  });

  test("refuses a secret the gateway cannot send, and says what to use", () => {
    const refused = (destination: string, secret: Record<string, unknown>) => {
      const r = model("", { x: { destinations: [destination], secret } });
      return [...r.failures(), ...r.reasons()];
    };
    expect(refused("api.example.com", { ref: "credsd://prod" })).toEqual([
      ["UNSUPPORTED_SECRET", "x"],
      "[egress.x] reads its secret from credsd://prod, and the gateway cannot read credsd. Use " +
        "an env:// secret, which build stores as an API key credential.",
    ]);
    expect(refused("api.example.com", { ref: "vault://kv" })).toEqual([
      ["UNSUPPORTED_SECRET", "x"],
      "[egress.x] has the secret vault://kv, and the gateway takes only an aws:// or env:// " +
        "secret. Use one of them.",
    ]);
    expect(
      refused("api.example.com", { ref: "env://KEY", placement: "query_param", param: "key" }),
    ).toEqual([
      ["UNSUPPORTED_SECRET_PLACEMENT", "x"],
      "[egress.x] sends its secret as query_param, and a gateway target sends an API key only " +
        'in a header. Set `placement` to "header", if the host takes the key in a header.',
    ]);
    expect(refused("api.example.com", { ref: "aws://default" })).toEqual([
      ["UNSIGNABLE_HOST", "x"],
      "[egress.x] signs requests to api.example.com with aws://default, and the gateway signs " +
        "only for Bedrock, AgentCore, and Lambda function URL hosts. Use an env:// secret for " +
        "this host, or remove the secret.",
    ]);
    expect(refused("api.example.com/v1", { ref: "env://KEY" })).toEqual([
      ["PATH_SCOPED_SECRET", "x"],
      "[egress.x] sends its secret only under /v1, and a gateway target sends its credential " +
        "on every path of the host. Remove the path from the destination.",
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
    const example = 'for example context.input.host == "api.example.com".';
    expect(r.lines()).toEqual([
      '.box/agent/local/profile.toml:2:1  [egress.wide] has the wildcard destination "*.example.com", and ' +
        "each gateway target needs one fixed host. Name each host in `destinations`.",
      '.box/agent/local/policy.dw:1:1  The rule "wild" allows each host that matches "*.example.com", and ' +
        `each gateway target needs one fixed host. Name each host in the rule, ${example}`,
      '.box/agent/local/policy.dw:2:1  The rule "anywhere" allows requests to every host, and each gateway ' +
        `target needs one fixed host. Add a condition that names each host, ${example}`,
      '.box/agent/local/policy.dw:3:1  The rule "not_one" allows every host except the ones it excludes ' +
        '(context.input.host != "evil.example.com"), and each gateway target needs one fixed ' +
        `host. Name each host it allows, ${example}`,
    ]);
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
    expect(
      model(
        permit("plain", on("a.example.com", "context.input.intercepted == false")) +
          permit("port80", on("b.example.com", "context.input.port == 80")),
        { http: { destinations: ["c.example.com:80"] } },
      ).reasons(),
    ).toEqual([
      '[egress.http] has the destination "c.example.com:80", which is plain HTTP, and the ' +
        "gateway reaches hosts only over HTTPS. Use port 443.",
      'The rule "plain" allows only plain HTTP requests, as it requires that ' +
        "context.input.intercepted is false, and the gateway reaches hosts only over HTTPS. " +
        "Remove that condition.",
      'The rule "port80" allows b.example.com on port 80, which is plain HTTP, and the gateway ' +
        "reaches hosts only over HTTPS. Use port 443.",
    ]);
  });

  test("fails a rule that allows only PUT, PATCH, or HEAD, and keeps the routable methods", () => {
    const r = model(
      permit("put", on("a.example.com", '["PUT", "PATCH", "HEAD"].contains(context.input.method)')),
    );
    expect(r.failures()).toEqual([["METHOD_NOT_ROUTABLE", "put"]]);
    expect(r.reasons()).toEqual([
      'The rule "put" allows only PUT, PATCH, HEAD on a.example.com, and the gateway sends ' +
        "only GET, POST, and DELETE requests to a host. Allow GET, POST, or DELETE in the rule, " +
        "or remove the rule.",
    ]);
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
    expect(r.lines()).toEqual([
      ".box/agent/local/profile.toml:2:1  [egress.x] already has `backends`, and build sends each host " +
        "through the gateway itself. Remove `backends` from the entry.",
      '.box/agent/local/policy.dw:1:1  The rule "x_get" allows a.example.com, and [egress.x] for that host ' +
        "has a problem. Fix [egress.x] first.",
    ]);
  });

  test("refuses an [egress] entry that sets protocol = mcp, and names the [mcp] server to write", () => {
    const r = model("", { m: { destinations: ["mcp.example.com"], protocol: "mcp" } });
    expect(r.failures()).toEqual([["MCP_OVER_HTTP", "m"]]);
    expect(r.lines()).toEqual([
      '.box/agent/local/profile.toml:2:1  [egress.m] sets protocol = "mcp", which Box does not take. ' +
        'Declare the server as [mcp.m] with type = "http", and remove this entry.',
    ]);
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
    expect(r.reasons()).toEqual([
      '[egress.caps] has the destination "Api.example.com", whose host never matches, because ' +
        'Box compares hosts in lower case with no trailing dot. Write the host as "api.example.com".',
      '[egress.under] has the destination "my_host.example.com", whose host has a character ' +
        'that the host of a gateway target cannot have. Use a host with only letters, digits, "-", ' +
        'and ".".',
      '[egress.six] has the destination "[::1]:8443", whose host is an IPv6 address, and a ' +
        "gateway target cannot reach one. Use a host name or an IPv4 address.",
      'The rule "upper" compares the host with "API.example.com" (context.input.host == ' +
        '"API.example.com"), which never matches, because Box compares hosts in lower case with ' +
        'no trailing dot. Write the host as "api.example.com".',
      'The rule "dot" compares the host with "x.example.com." (context.input.host == ' +
        '"x.example.com."), which never matches, because Box compares hosts in lower case with ' +
        'no trailing dot. Write the host as "x.example.com".',
    ]);
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
    expect(r.lines()).toEqual([
      ".box/agent/local/policy.dw:5:67  Syntax error: unexpected } in a condition. Correct the rule at this " +
        "place.",
      '.box/agent/local/policy.dw:2:1  The rule "dup" has the same @id as the rule at .box/agent/local/policy.dw:1:1. ' +
        "Give each rule its own @id.",
      '.box/agent/local/policy.dw:3:1  The rule "verb" names the action Box::Action::"http:get", which Box ' +
        'does not have. Use a Box action, such as Box::Action::"http:request" or ' +
        'Box::Action::"net:connect".',
      '.box/agent/local/policy.dw:4:1  The rule "query" reads context.input.query, which http:request does ' +
        "not have. Use one of context.input.host, context.input.port, context.input.method, " +
        "context.input.path, context.input.body_bytes, context.input.intercepted, " +
        "context.input.upgrade, or context.output.status.",
    ]);
  });

  test("puts a copy of a rule Box adds at the user's copy, and names what makes Box add it", () => {
    const github = { destinations: ["api.github.com"] };
    const copied = model(
      "// Copied from box profile show.\n" + connect("route_github_connect", on("api.github.com")),
      { github },
    );
    const metadata = model(forbid("metadata_hosts", on("x.example.com")), { github });
    const packed = model(
      forbid("pack_rule", on("x.example.com")),
      { github },
      {
        packRules: forbid("pack_rule", on("y.example.com")),
      },
    );

    const boxFirst = model(
      forbid("shared", on("x.example.com")),
      {},
      {
        boxFirst: forbid("shared", on("y.example.com")),
      },
    );

    expect([
      ...copied.lines(),
      ...boxFirst.lines(),
      ...metadata.lines(),
      ...packed.lines(),
    ]).toEqual([
      '.box/agent/local/policy.dw:2:1  The rule "route_github_connect" is one Box adds itself for ' +
        "[egress.github]. Remove it from .box/agent/local/policy.dw.",
      '.box/agent/local/policy.dw:1:1  The rule "shared" has the same @id as a rule that a pack in ' +
        "`packs` adds. Give your rule another @id.",
      '.box/agent/local/policy.dw:1:1  The rule "metadata_hosts" is one Box adds itself to every profile. ' +
        "Remove it from .box/agent/local/policy.dw.",
      '.box/agent/local/policy.dw:1:1  The rule "pack_rule" has the same @id as a rule that a pack in ' +
        "`packs` adds. Give your rule another @id.",
    ]);
  });

  test("puts a failing rule or entry that Box or a pack adds at the part of the profile that adds it", () => {
    const r = model(
      "",
      { github: { destinations: ["api.github.com"] } },
      {
        packRules:
          permit("pack_wild", 'context.input.host like "*.pack.example.com"') +
          "permit (principal, action, resource) when { context.input.port == 1 };\n",
      },
    );
    const unnamed = model(
      `permit (principal, ${HR}, resource) when { context.input.port == 1 };\n`,
    );

    const rest = "and each gateway target needs one fixed host.";
    expect(r.lines().map((line) => line.slice(0, line.indexOf(rest) + rest.length))).toEqual([
      '.box/agent/local/profile.toml:1:1  The rule "pack_wild", which a pack in `packs` adds, allows each ' +
        `host that matches "*.pack.example.com", ${rest}`,
      `.box/agent/local/profile.toml:1:1  A rule that a pack in \`packs\` adds allows requests to every host, ${rest}`,
    ]);
    expect(unnamed.lines()).toEqual([
      `.box/agent/local/policy.dw:1:1  This rule allows requests to every host, ${rest} Add a condition ` +
        'that names each host, for example context.input.host == "api.example.com".',
    ]);
  });
});

describe("HTTP MCP servers", () => {
  const server = (destinations: string[], rest: Record<string, unknown> = {}) => ({
    type: "http",
    destinations,
    ...rest,
  });

  test("gives a server with no secret a target named after it, which sends no credential", () => {
    const r = model("", {}, { mcp: { tools: server(["tools.example.com"]) } });
    expect(r.failures()).toEqual([]);
    expect(r.host("tools.example.com")).toMatchObject({
      target: "egress-tools",
      outboundAuth: { kind: "none" },
      reachable: true,
      sources: [
        { kind: "mcp", mcpEntry: "tools", destinations: ["tools.example.com"] },
        { kind: "rule", ruleId: "mcp_tools_connect" },
        { kind: "rule", ruleId: "mcp_tools_request" },
      ],
    });
    expect(r.network.credentials).toEqual([]);
  });

  test("sends an env:// server's key from the API key credential named after it, and keeps its secret", () => {
    const secret = { ref: "env://TOOLS_TOKEN", header: "x-api-key", phantom_prefix: "tk-" };
    const r = model("", {}, { mcp: { tools: server(["tools.example.com"], { secret }) } });
    expect(r.failures()).toEqual([]);
    expect(r.host("tools.example.com")).toMatchObject({
      target: "egress-tools",
      outboundAuth: {
        kind: "apiKey",
        credentialName: "tools",
        variable: "TOOLS_TOKEN",
        header: "x-api-key",
      },
      sources: [
        { kind: "mcp", mcpEntry: "tools", destinations: ["tools.example.com"], secret },
        { kind: "rule", ruleId: "mcp_tools_connect" },
        { kind: "rule", ruleId: "mcp_tools_request" },
      ],
    });
    expect(r.network.credentials).toEqual([{ name: "tools", variable: "TOOLS_TOKEN" }]);
  });

  test("signs an aws:// server on an AWS host with the gateway's role, and refuses one on another host", () => {
    const host = "abc123.lambda-url.us-west-2.on.aws";
    const signed = model("", {}, { mcp: { fn: server([host], { secret: { ref: "aws://" } }) } });
    expect(signed.failures()).toEqual([]);
    expect(signed.host(host)).toMatchObject({
      target: "egress-fn",
      outboundAuth: { kind: "iam", service: "lambda", region: "us-west-2" },
    });
    const unsigned = model(
      "",
      {},
      { mcp: { tools: server(["tools.example.com"], { secret: { ref: "aws://default" } }) } },
    );
    expect(unsigned.lines()).toEqual([
      ".box/agent/local/profile.toml:2:1  [mcp.tools] signs requests to tools.example.com with " +
        "aws://default, and the gateway signs only for Bedrock, AgentCore, and Lambda function " +
        "URL hosts. Use an env:// secret for this host, or remove the secret.",
    ]);
  });

  test("stops on a server with two destinations, a path, or a wildcard, at its entry", () => {
    const r = model(
      "",
      {},
      {
        mcp: {
          two: server(["a.example.com", "b.example.com"]),
          pathed: server(["c.example.com/mcp"]),
          wild: server(["*.example.com"]),
        },
      },
    );
    expect(r.failures()).toEqual([
      ["MCP_DESTINATION_NOT_ONE_HOST", "two"],
      ["MCP_DESTINATION_NOT_ONE_HOST", "pathed"],
      ["MCP_DESTINATION_NOT_ONE_HOST", "wild"],
    ]);
    expect(r.lines()).toEqual([
      ".box/agent/local/profile.toml:2:1  [mcp.two] names 2 destinations, and the gateway route of " +
        "an MCP server takes exactly one host. Declare one [mcp] server for each host.",
      '.box/agent/local/profile.toml:3:1  [mcp.pathed] has the destination "c.example.com/mcp", and ' +
        "the gateway route of an MCP server takes a host with no path. Remove /mcp from the " +
        "destination. The agent's MCP client keeps the path in its URL.",
      '.box/agent/local/profile.toml:4:1  [mcp.wild] has the wildcard destination "*.example.com", ' +
        "and the gateway route of an MCP server takes one exact host. Name the server's host.",
    ]);
    expect(r.network.hosts).toEqual([]);
  });

  test("fails a server whose target name an [egress] entry's target has, with the collision failure", () => {
    const r = model("", { github: GITHUB }, { mcp: { github: server(["api.githubcopilot.com"]) } });
    expect(r.failures()).toEqual([["TARGET_NAME_COLLISION", "github"]]);
    expect(r.lines()).toEqual([
      ".box/agent/local/profile.toml:3:1  [mcp.github] would name the gateway target for " +
        "api.githubcopilot.com 'egress-github', and [egress.github] for api.github.com has that " +
        "name. Rename the entry.",
    ]);
  });

  test("fails a server that takes the API key credential of an [egress] entry for another variable", () => {
    const r = model(
      "",
      {
        tools: {
          destinations: ["a.example.com", "b.example.com"],
          secret: { ref: "env://TOOLS_KEY" },
        },
      },
      { mcp: { tools: server(["mcp.example.com"], { secret: { ref: "env://TOOLS_MCP_KEY" } }) } },
    );
    expect(r.targets()).toEqual([
      "a.example.com -> egress-tools-a-example-com",
      "b.example.com -> egress-tools-b-example-com",
      "mcp.example.com -> egress-tools",
    ]);
    expect(r.failures()).toEqual([["API_KEY_CREDENTIAL_SHARED", "tools"]]);
    expect(r.lines()).toEqual([
      ".box/agent/local/profile.toml:3:1  [mcp.tools] needs the API key credential 'tools' for " +
        "env://TOOLS_MCP_KEY, and [egress.tools] takes that credential for env://TOOLS_KEY. One " +
        "credential holds one key. Rename the entry.",
    ]);
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

describe("WebSocket", () => {
  const WS = 'context.input.upgrade == "websocket"';
  const chat = (rest: string) =>
    connect("chat_connect", on("chat.example.com")) + permit("chat", on("chat.example.com", rest));

  test("skips a permit that allows only WebSocket handshakes, with a warning and no failure", () => {
    const r = model(chat(WS));
    expect(r.failures()).toEqual([]);
    expect(r.network.hosts.filter((h) => h.target !== undefined)).toEqual([]);
    expect(r.network.warnings).toEqual([
      '.box/agent/local/policy.dw:2:1: The rule "chat" allows only WebSocket connections, and build adds no ' +
        "gateway target for a WebSocket, so it skips this rule.",
    ]);
  });

  test("keeps the HTTP requests of a permit that also allows a WebSocket", () => {
    const r = model(chat(`(${WS} || context.input.method == "GET")`));
    expect(r.failures()).toEqual([]);
    expect(r.targets()).toEqual(["chat.example.com -> egress-chat-example-com"]);
    expect(r.network.warnings.some((w) => w.includes("WebSocket"))).toBe(false);
  });

  test("reads upgrade as empty on every request the gateway carries", () => {
    for (const test of ['context.input.upgrade == ""', 'context.input.upgrade != "websocket"']) {
      const r = model(chat(test) + forbid("no_ws", on("chat.example.com", WS)));
      expect(r.failures()).toEqual([]);
      expect(r.targets()).toEqual(["chat.example.com -> egress-chat-example-com"]);
      expect(r.network.warnings).toEqual([]);
    }
  });

  test("skips the websocket:send and websocket:receive rules", () => {
    const messages = rule(
      "messages",
      'permit (principal, action in [Box::Action::"websocket:send", ' +
        'Box::Action::"websocket:receive"], resource) when { context.input.host == ' +
        '"chat.example.com" && context.input.opcode == Box::WebSocketOpcode::"text" };',
    );
    const r = model(messages);
    expect(r.failures()).toEqual([]);
    expect(r.network.hosts).toEqual([]);
    expect(r.network.warnings).toEqual([]);
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
      'api.github.com: the gateway allows every request to this host; Box still applies the rule "no_admin".',
      'httpbin.org: the gateway allows every request to this host; Box still applies the rule "get". ' +
        "On AgentCore Runtime, Box applies only your forbid rules to this host, so write each " +
        "limit as a forbid rule to keep it there.",
    ]);
  });

  test("names an entry whose host gets no target, and the forbids that deny it", () => {
    expect(
      model(forbid("no_github", on("api.github.com")), { github: GITHUB }).network.warnings,
    ).toEqual([
      'api.github.com: your policy allows no request to this host (the rule "no_github" denies ' +
        "it), so [egress.github] gets no gateway target.",
    ]);
  });

  test("names each target the gateway signs for an endpoint that no policy of its role allows", () => {
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
      "Target 'bedrock' calls bedrock with the gateway's role, which has no bedrock permissions. " +
        "Add an IAM policy file to additionalPolicies of the 'agent-box' gateway.",
      "Target 'egress-control' calls bedrock with the gateway's role, which has no bedrock " +
        "permissions. Add an IAM policy file to additionalPolicies of the 'agent-box' gateway.",
    ]);
    // The model calls' grants allow the runtime host, not the control plane.
    const controlWarning =
      "Target 'egress-control' calls bedrock.us-west-2.amazonaws.com with the gateway's role, " +
      "which has no bedrock permissions for that host. Add an IAM policy file to " +
      "additionalPolicies of the 'agent-box' gateway.";
    const granted = model("", egress, {
      targets: [control],
      grantedActions: ["bedrock:InvokeModel"],
    });
    expect(boxGatewayIamWarnings(granted.spec, granted.network)).toEqual([controlWarning]);
    const listed = model("", egress, {
      targets: [...getBoxGatewayBedrockEntry("agent").targets, control],
    });
    listed.spec.agentCoreGateways[0]!.additionalPolicies = ["agentcore/box-bedrock-policy.json"];
    expect(boxGatewayIamWarnings(listed.spec, listed.network)).toEqual([controlWarning]);
    const imported = model("", egress, {
      targets: [control],
      executionRoleArn: "arn:aws:iam::123456789012:role/mine",
    });
    expect(boxGatewayIamWarnings(imported.spec, imported.network)).toEqual([]);
  });

  describe("the grant each endpoint of a target needs", () => {
    const BEDROCK_FILE = "agentcore/box-bedrock-policy.json";
    const MEMORY_FILE = "agentcore/box-memory-policy.json";
    const signed = (name: string, host: string, service: string) =>
      passthrough(name, `https://${host}`, {
        outboundAuth: { type: "GATEWAY_IAM_ROLE", service, region: "us-west-2" },
      });
    const RUNTIME_HOST = "bedrock-runtime.us-west-2.amazonaws.com";
    const CONTROL_HOST = "bedrock.us-west-2.amazonaws.com";
    const AGENTCORE_CONTROL_HOST = "bedrock-agentcore-control.us-west-2.amazonaws.com";
    const URL_HOST = "abc123.lambda-url.us-west-2.on.aws";
    const runtime = signed("egress-bedrock-runtime", RUNTIME_HOST, "bedrock");
    const control = signed("egress-bedrock-control", CONTROL_HOST, "bedrock");
    const agentcoreControl = signed(
      "egress-agentcore-control",
      AGENTCORE_CONTROL_HOST,
      "bedrock-agentcore",
    );
    const functionUrl = signed("egress-fn", URL_HOST, "lambda");
    /** The warnings for `target` when the listed files hold `granted`, and `listed` is listed. */
    const warningsFor = (
      target: AgentCoreGatewayTarget,
      granted: string[] = [],
      listed: string[] = [],
    ) => {
      const r = model("", {}, { targets: [target], grantedActions: granted });
      r.spec.agentCoreGateways[0]!.additionalPolicies = listed;
      return boxGatewayIamWarnings(r.spec, r.network);
    };
    const forHost = (target: string, host: string, service: string) =>
      `Target '${target}' calls ${host} with the gateway's role, which has no ${service} ` +
      "permissions for that host. Add an IAM policy file to additionalPolicies of the " +
      "'agent-box' gateway.";
    const forService = (target: string, service: string) =>
      `Target '${target}' calls ${service} with the gateway's role, which has no ${service} ` +
      "permissions. Add an IAM policy file to additionalPolicies of the 'agent-box' gateway.";

    test("a Bedrock control-plane target needs a Bedrock action other than the model calls", () => {
      const warned = [forHost("egress-bedrock-control", CONTROL_HOST, "bedrock")];
      expect(warningsFor(control, [], [BEDROCK_FILE])).toEqual(warned);
      expect(
        warningsFor(
          control,
          [
            "bedrock:InvokeModel",
            "bedrock:InvokeModelWithResponseStream",
            "bedrock:CountTokens",
            "bedrock:InvokeModel*",
            "lambda:*",
          ],
          [BEDROCK_FILE],
        ),
      ).toEqual(warned);
      for (const granted of [
        "bedrock:ListFoundationModels",
        "BEDROCK:listfoundationmodels",
        "bedrock:*",
        "bedrock:Get*",
        "*",
      ]) {
        expect(warningsFor(control, [granted], [BEDROCK_FILE])).toEqual([]);
      }
      expect(warningsFor(control)).toEqual([forService("egress-bedrock-control", "bedrock")]);
    });

    test("a Bedrock runtime target needs bedrock:InvokeModel, which the Bedrock file grants", () => {
      expect(warningsFor(runtime, [], [BEDROCK_FILE])).toEqual([]);
      for (const granted of ["BEDROCK:invokemodel", "bedrock:Invoke*", "bedrock:InvokeMode?"]) {
        expect(warningsFor(runtime, [granted])).toEqual([]);
      }
      const warned = [forHost("egress-bedrock-runtime", RUNTIME_HOST, "bedrock")];
      expect(warningsFor(runtime, ["bedrock:ListFoundationModels"])).toEqual(warned);
      expect(warningsFor(runtime, ["bedrock:InvokeModelWithResponseStream"])).toEqual(warned);
      expect(warningsFor(runtime)).toEqual([forService("egress-bedrock-runtime", "bedrock")]);
    });

    test("a Lambda function URL target needs lambda:InvokeFunctionUrl", () => {
      expect(warningsFor(functionUrl, ["lambda:InvokeFunctionUrl"])).toEqual([]);
      expect(warningsFor(functionUrl, ["lambda:Invoke*"])).toEqual([]);
      expect(warningsFor(functionUrl, ["lambda:InvokeFunction"])).toEqual([
        forHost("egress-fn", URL_HOST, "lambda"),
      ]);
      expect(warningsFor(functionUrl, ["bedrock:*"])).toEqual([forService("egress-fn", "lambda")]);
    });

    test("an AgentCore target needs an AgentCore grant, and the Memory file covers only Memory", () => {
      expect(warningsFor(getBoxGatewayAgentCoreTargetSpec(), [], [MEMORY_FILE])).toEqual([]);
      expect(warningsFor(agentcoreControl, [], [MEMORY_FILE])).toEqual([
        forHost("egress-agentcore-control", AGENTCORE_CONTROL_HOST, "bedrock-agentcore"),
      ]);
      expect(warningsFor(agentcoreControl, ["bedrock-agentcore:*"], [MEMORY_FILE])).toEqual([]);
      expect(warningsFor(getBoxGatewayAgentCoreTargetSpec("us-east-1"), [], [MEMORY_FILE])).toEqual(
        [forHost("agentcore", "bedrock-agentcore.us-east-1.amazonaws.com", "bedrock-agentcore")],
      );
      expect(warningsFor(agentcoreControl)).toEqual([
        forService("egress-agentcore-control", "bedrock-agentcore"),
      ]);
    });
  });
});

describe("third-party telemetry", () => {
  const LANGSMITH = { kind: "langsmith", secret: { ref: "env://LANGSMITH_KEY" } };
  const COLLECTOR = { kind: "otlp", destination: "https://collector.example.com" };
  const CONTAINER = { build: "Container", entrypoint: "main.py" } as const;
  /** The model of a container runtime with the switch on, unless `options` says otherwise. */
  const telemetryOf = (options: Options) => {
    const { network } = model("", {}, { secretsManager: true, runtime: CONTAINER, ...options });
    return {
      names: (network.thirdPartyTelemetry ?? []).map(({ name }) => name),
      warnings: network.warnings,
    };
  };

  test("carries no third-party target with the switch off, as before, and warns for each with a key", () => {
    const telemetry = { langsmith: LANGSMITH, collector: COLLECTOR };

    expect(telemetryOf({ telemetry, secretsManager: false })).toEqual({
      names: [],
      warnings: [
        `${PROFILE}: the AgentCore Runtime profile leaves out [telemetry.langsmith]: on ` +
          "AgentCore Runtime, Box reads its key from AWS Secrets Manager, and no Box release for " +
          "Linux can do that yet. To try a box build that can, set AGENTCORE_BOX_SECRETS_MANAGER=1.",
      ],
    });
  });

  test("carries no target with a key for a CodeZip runtime, which has no AWS CLI", () => {
    const telemetry = { langsmith: LANGSMITH, collector: COLLECTOR };

    const { names, warnings } = telemetryOf({ telemetry, runtime: {} });

    expect(names).toEqual(["collector"]);
    expect(warnings).toEqual([
      `${PROFILE}: the AgentCore Runtime profile leaves out [telemetry.langsmith]: Box reads its ` +
        "key on AgentCore Runtime with the AWS CLI, which a CodeZip runtime does not have. Use a " +
        "container runtime.",
    ]);
  });

  test("carries each target the Runtime can send to, and says why it leaves out each other one", () => {
    const telemetry = {
      langsmith: LANGSMITH,
      collector: COLLECTOR,
      signed: { ...COLLECTOR, secret: { ref: "aws://my-profile" } },
    };

    expect(telemetryOf({ telemetry })).toEqual({
      names: ["langsmith", "collector"],
      warnings: [
        `${PROFILE}: the AgentCore Runtime profile leaves out [telemetry.signed]: its ` +
          "`secret.ref` names no `env://` or `secret://` variable, and build moves only such a " +
          "key to AWS Secrets Manager.",
      ],
    });
  });

  test("leaves out a target whose deploy variable a credential reads, so no key goes to the wrong place", () => {
    const credentials = [
      { authorizerType: "ApiKeyCredentialProvider" as const, name: "agent_telemetry_langsmith" },
    ];

    expect(telemetryOf({ telemetry: { langsmith: LANGSMITH }, credentials })).toEqual({
      names: [],
      warnings: [
        `${PROFILE}: the AgentCore Runtime profile leaves out [telemetry.langsmith]: deploy reads ` +
          "its key from AGENTCORE_CREDENTIAL_AGENT_TELEMETRY_LANGSMITH, and a credential or " +
          "another target reads that variable too. Rename the target.",
      ],
    });
  });

  test("leaves out the second of two targets with one deploy variable, and keeps one with no key", () => {
    const telemetry = { "my-key": LANGSMITH, my_key: LANGSMITH, "my-collector": COLLECTOR };

    const { names, warnings } = telemetryOf({ telemetry });

    expect(names).toEqual(["my-key", "my-collector"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("leaves out [telemetry.my_key]: deploy reads its key from");
  });
});
