import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { getBoxGatewayBedrockTargetSpec } from "../../../handlers/project/shortcuts";
import type { AgentCoreGatewayTarget } from "../../../projectSchemas/gateway";
import { boxGatewaySpec, type ProjectSpec } from "../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import { boxNetworkRules } from "../boxProfileResolver-test-support";
import type { PassthroughGatewayCheck } from "../backends/cdk/compatibility";
import { boxSigningOf } from "./egress";
import { boxGatewayIamWarnings, buildBoxNetwork } from "./network";
import { parseResolvedPolicy } from "./policyParser";
import { profilePlaces } from "./profileParser";

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
  /** The other gateways of the project, after the Box gateway. */
  readonly gateways?: Record<string, unknown>[];
  readonly runtime?: Partial<ProjectRuntime>;
  /** What the check of the @aws/agentcore-cdk of the project gives; it accepts here. */
  readonly projectGatewayCheck?: PassthroughGatewayCheck;
  /** The targets that agentcore/box-gateway-targets.json names for the gateway. */
  readonly ownedTargets?: ReadonlySet<string>;
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
    agentCoreGateways: [
      {
        ...boxGatewaySpec("agent"),
        targets: options.targets ?? [],
        ...(options.executionRoleArn && { executionRoleArn: options.executionRoleArn }),
      },
      ...(options.gateways ?? []),
    ],
  } as unknown as ProjectSpec;
  const mcp = options.mcp ?? {};
  const profile = [
    'packs = ["@box/base"]',
    ...Object.keys(egress).map((name) => `[egress.${JSON.stringify(name)}]`),
    ...Object.keys(mcp).map((name) => `[mcp.${JSON.stringify(name)}]`),
  ].join("\n");
  const { parsed, failures } = parseResolvedPolicy(
    {
      path: PROFILE,
      egress,
      mcp,
      policyFiles: policy ? ["policy.dw"] : [],
      places: profilePlaces(profile, PROFILE),
    },
    `${options.boxFirst ?? ""}${policy}\n${options.packRules ?? ""}${boxNetworkRules(egress, mcp)}`,
    policy ? [{ file: ".box/agent/local/policy.dw", text: policy }] : [],
  );
  const network = buildBoxNetwork(parsed, failures, {
    spec,
    runtime,
    gateway: "agent-box-egress",
    region: "us-west-2",
    targets: options.targets ?? [],
    grantedActions: options.grantedActions ?? [],
    projectGatewayCheck: options.projectGatewayCheck ?? { accepts: true },
    ...(options.ownedTargets && { ownedTargets: options.ownedTargets }),
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
        models: {
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

  describe("the targets build owns", () => {
    const mcpTarget = passthrough("egress-github", "https://api.github.com", {
      passthrough: { endpoint: "https://api.github.com", protocolType: "MCP" },
    });
    const queryKey = passthrough("egress-old", "https://old.example.com", {
      outboundAuth: {
        type: "API_KEY",
        credentialName: "old",
        location: "QUERY_PARAMETER",
        parameterName: "key",
      },
    });

    test("are the ones agentcore/box-gateway-targets.json names, and a user's egress- target is not", () => {
      const r = model(
        "",
        { github: GITHUB },
        {
          targets: [passthrough("egress-mine", "https://mine.example.com"), queryKey],
          ownedTargets: new Set(),
        },
      );
      expect(r.failures()).toEqual([]);
      expect([...r.network.managedTargets]).toEqual(["egress-github"]);
      expect(r.network.warnings.filter((w) => w.includes("'egress-"))).toEqual([]);
    });

    test("fail a target the file names that the user changed, and say how to keep it", () => {
      const r = model(
        "",
        { github: GITHUB },
        {
          targets: [mcpTarget, queryKey],
          ownedTargets: new Set(["egress-github", "egress-old"]),
        },
      );
      expect(r.failures()).toEqual([
        ["MANAGED_TARGET_CHANGED", "egress-github"],
        ["MANAGED_TARGET_CHANGED", "egress-old"],
      ]);
      expect(r.lines()[1]).toBe(
        "agentcore/agentcore.json  The gateway target 'egress-old' sends the API key credential " +
          "'old' in the query parameter key, which build does not write, and " +
          "agentcore/box-gateway-targets.json names it as a target that build writes, so build " +
          "does not change or remove it. Remove 'egress-old' from that file to keep the target " +
          "as yours, or remove the target so build writes it again.",
      );
    });

    test("are, for a gateway the file does not name, the egress- targets that build would write", () => {
      const r = model(
        "",
        { github: GITHUB },
        {
          targets: [passthrough("egress-stale", "https://stale.example.com"), queryKey],
        },
      );
      expect(r.failures()).toEqual([]);
      expect([...r.network.managedTargets]).toEqual(["egress-stale", "egress-github"]);
      // The one build that takes the old egress- targets says which one it keeps as the user's.
      expect(r.network.warnings.filter((w) => w.includes("'egress-"))).toEqual([
        "agentcore/agentcore.json: build keeps the gateway target 'egress-old' as yours, because " +
          "it sends the API key credential 'old' in the query parameter key, which build does " +
          "not write. Build does not change or remove it. Remove the target if build wrote it " +
          "before and you do not use it.",
      ]);
    });

    test("leave a user's target of another shape on an entry's host to the user", () => {
      const r = model("", { github: GITHUB }, { targets: [mcpTarget] });
      expect(r.failures()).toEqual([["EXISTING_TARGET_CONFLICT", "github"]]);
      expect([...r.network.managedTargets]).toEqual([]);
    });
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
      ".box/agent/local/profile.toml  The gateway 'agent-box-egress' needs 101 targets, 99 for the hosts of the " +
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

  test("names the credential that reserves the variable, else the one named after the entry", () => {
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
    expect(covering.network.envRoutes).toEqual([
      { route: "openai", variable: "AGENTCORE_CREDENTIAL_AGENTOPENAIAPIKEY" },
    ]);
    expect(model("", { github: GITHUB }).network.envRoutes).toEqual([
      { route: "github", variable: "GITHUB_TOKEN" },
    ]);
  });

  test("takes one credential for its own variable and for one other variable, which build copies to it", () => {
    const github = { authorizerType: "ApiKeyCredentialProvider", name: "github" } as const;
    const mirror = {
      destinations: ["mirror.example.com"],
      secret: { ref: "env://AGENTCORE_CREDENTIAL_GITHUB" },
    };
    for (const egress of [
      { mirror, github: GITHUB },
      { github: GITHUB, mirror },
    ]) {
      const shared = model("", egress, { credentials: [github] });
      expect(shared.failures()).toEqual([]);
      expect(shared.network.hosts.map(({ outboundAuth }) => outboundAuth)).toMatchObject([
        { kind: "apiKey", credentialName: "github" },
        { kind: "apiKey", credentialName: "github" },
      ]);
    }
  });

  test("leaves an env:// entry that cannot name an API key credential to the credentials writer", () => {
    const invalid = model("", {
      ab: { destinations: ["a.example.com"], secret: { ref: "env://KEY" } },
    });
    expect(invalid.failures()).toEqual([]);
    expect(invalid.host("a.example.com")?.outboundAuth).toMatchObject({ credentialName: "ab" });
    expect(invalid.network.envRoutes).toEqual([{ route: "ab", variable: "KEY" }]);
  });

  test("gives no route a credential for a host that gets no target", () => {
    const denied = model(forbid("no_github", on("api.github.com")), { github: GITHUB });
    expect(denied.targets()).toEqual(["api.github.com -> (none)"]);
    expect(denied.network.envRoutes).toEqual([]);
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
      "[egress.x] signs requests to api.example.com with aws://default, and build cannot find " +
        "the AWS service and the region of this host. Use an env:// secret for this host, or " +
        "remove the secret. For an AWS API on a custom domain, add a GATEWAY_IAM_ROLE " +
        "passthrough target for https://api.example.com to the 'agent-box-egress' gateway.",
    ]);
    expect(refused("api.example.com/v1", { ref: "env://KEY" })).toEqual([
      ["PATH_SCOPED_SECRET", "x"],
      "[egress.x] sends its secret only under /v1, and a gateway target sends its credential " +
        "on every path of the host. Remove the path from the destination.",
    ]);
  });

  test("signs aws:// on an AWS host outside the managed endpoints with the service and region Box signs it with, and grants nothing", () => {
    const host = "s3.us-west-2.amazonaws.com";
    const r = model("", { s3: { destinations: [host], secret: { ref: "aws://" } } });

    expect(r.failures()).toEqual([]);
    expect(r.host(host)).toMatchObject({
      target: "egress-s3",
      outboundAuth: { kind: "iam", service: "s3", region: "us-west-2" },
    });
    expect(r.network.managedTargets).toEqual(new Set(["egress-s3"]));
    expect(r.network.warnings.join("\n")).not.toContain("signs requests to");
    expect(r.network.grantedActions).toEqual([]);
  });

  test("reads the service and region of a host as Box does, except for an empty label", () => {
    const cases: [string, { service: string; region: string } | undefined][] = [
      ["s3.us-east-1.amazonaws.com", { service: "s3", region: "us-east-1" }],
      ["S3.US-WEST-2.AMAZONAWS.COM.", { service: "s3", region: "us-west-2" }],
      ["iam.amazonaws.com", { service: "iam", region: "us-east-1" }],
      [
        "abc123.execute-api.eu-west-1.amazonaws.com",
        { service: "execute-api", region: "eu-west-1" },
      ],
      ["bedrock-runtime.us-east-2.amazonaws.com", { service: "bedrock", region: "us-east-2" }],
      [
        "bedrock-agent-runtime.us-west-2.amazonaws.com",
        { service: "bedrock", region: "us-west-2" },
      ],
      ["bedrock-runtime.us-east-1.api.aws", { service: "bedrock", region: "us-east-1" }],
      ["amazonaws.com", undefined],
      ["vpce-1234.s3.us-east-1.vpce.amazonaws.com", undefined],
      ["my-bucket.s3.us-west-2.amazonaws.com", undefined],
      ["s3.cn-north-1.amazonaws.com.cn", undefined],
      ["s3..amazonaws.com", undefined],
      ["api.example.com", undefined],
    ];
    for (const [host, signing] of cases)
      expect([host, boxSigningOf(host)]).toEqual([host, signing]);
  });

  const BUCKET = "my-bucket.s3.us-west-2.amazonaws.com";

  test("gives aws:// on an AWS host Box does not sign no target, and warns with what to add", () => {
    const r = model("", { bucket: { destinations: [BUCKET], secret: { ref: "aws://" } } });

    expect(r.failures()).toEqual([]);
    expect(r.targets()).toEqual([`${BUCKET} -> (none)`]);
    expect(r.network.managedTargets).toEqual(new Set());
    expect(r.network.warnings).toContain(
      `${PROFILE}:2:1: [egress.bucket] signs requests to ${BUCKET} with aws://, and Box does ` +
        "not sign for this host name, so build cannot find its service and its region and " +
        "makes no gateway target for it. The AgentCore Runtime box profile leaves this entry " +
        `out, and nothing signs the requests to ${BUCKET}. To sign them, add a passthrough ` +
        `target for https://${BUCKET} to the 'agent-box-egress' gateway in agentcore.json, with ` +
        "protocolType CUSTOM and outboundAuth type GATEWAY_IAM_ROLE. Give it the service and " +
        "the region of the host. Then add an IAM policy file with the permissions for the host " +
        "to additionalPolicies of that gateway.",
    );
  });

  test("routes aws:// on a host with no signing service through the user's own IAM target", () => {
    const mine = passthrough("my-bucket", `https://${BUCKET}`, {
      outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "s3" },
    });
    const r = model(
      "",
      { bucket: { destinations: [BUCKET], secret: { ref: "aws://" } } },
      { targets: [mine] },
    );

    expect(r.failures()).toEqual([]);
    expect(r.host(BUCKET)).toMatchObject({
      target: "my-bucket",
      outboundAuth: { kind: "iam", service: "s3" },
    });
    expect(r.network.managedTargets).toEqual(new Set());
    expect(r.network.warnings.join("\n")).not.toContain("signs requests to");
  });

  test("routes aws:// on a host that is not an AWS host through the user's own IAM target", () => {
    const host = "api.example.com";
    const mine = passthrough("my-api", `https://${host}`, {
      outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "execute-api", region: "us-west-2" },
    });
    const r = model(
      "",
      { api: { destinations: [host], secret: { ref: "aws://" } } },
      { targets: [mine] },
    );

    expect(r.failures()).toEqual([]);
    expect(r.host(host)).toMatchObject({
      target: "my-api",
      outboundAuth: { kind: "iam", service: "execute-api", region: "us-west-2" },
    });
    expect(r.network.managedTargets).toEqual(new Set());
    expect(r.network.warnings.join("\n")).not.toContain("signs requests to");
  });

  test("refuses the user's own target with other auth for aws:// on a host with no signing service", () => {
    const r = model(
      "",
      { bucket: { destinations: [BUCKET], secret: { ref: "aws://" } } },
      { targets: [passthrough("my-bucket", `https://${BUCKET}`)] },
    );

    expect(r.lines()).toEqual([
      `agentcore/agentcore.json  The gateway target 'my-bucket' for ${BUCKET} sends no ` +
        "credential, and [egress.bucket] sends requests signed with the gateway's role. Make the " +
        `two the same, in agentcore.json or in ${PROFILE}.`,
    ]);
    expect(r.failures()).toEqual([["EXISTING_TARGET_CONFLICT", "bucket"]]);
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

  test.each([65536, 0, -1])("fails each rule that names port %d, which is not a port", (port) => {
    const pinned = `context.input.port == ${port}`;
    const r = model(
      connect("odd_connect", on("api.example.com", pinned)) +
        permit("odd", on("api.example.com", pinned)),
    );
    expect(r.lines()).toEqual(
      [".box/agent/local/policy.dw:1:1", ".box/agent/local/policy.dw:2:1"].map(
        (place, i) =>
          `${place}  The rule "${["odd_connect", "odd"][i]}" allows api.example.com on port ` +
          `${port}, which is not a port. Name a port from 1 to 65535, such as ` +
          "context.input.port == 443.",
      ),
    );
    expect(r.targets()).toEqual([]);
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
    expect(r.network.warnings).toEqual([]);
    expect(r.network.envRoutes).toEqual([]);
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
    expect(r.network.envRoutes).toEqual([{ route: "tools", variable: "TOOLS_TOKEN" }]);
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
        "aws://default, and build cannot find the AWS service and the region of this host. Use " +
        "an env:// secret for this host, or remove the secret. For an AWS API on a custom " +
        "domain, add a GATEWAY_IAM_ROLE passthrough target for https://tools.example.com to " +
        "the 'agent-box-egress' gateway.",
    ]);
    expect(unsigned.failures()).toEqual([["UNSIGNABLE_HOST", "tools"]]);
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

  test("says that the policy allows no request to a server it forbids, and gives it no target", () => {
    const r = model(
      forbid("no_tools", on("tools.example.com")),
      {},
      {
        mcp: { tools: server(["tools.example.com"]) },
      },
    );
    expect(r.targets()).toEqual(["tools.example.com -> (none)"]);
    expect(r.network.warnings).toEqual([
      'tools.example.com: your policy allows no request to this host (the rule "no_tools" ' +
        "denies it), so [mcp.tools] gets no gateway target.",
    ]);
  });
});

describe("the default targets", () => {
  test("gives the Memory endpoint of an entry an egress- target: build adds no target for Memory", () => {
    const r = model("", {
      memory: {
        destinations: ["bedrock-agentcore.us-west-2.amazonaws.com"],
        secret: { ref: "aws://default" },
      },
    });
    expect(r.targets()).toEqual(["bedrock-agentcore.us-west-2.amazonaws.com -> egress-memory"]);
    expect(r.failures()).toEqual([]);
  });

  test("gives @box/bedrock's model endpoint to the bedrock target build adds", () => {
    const signed = { secret: { ref: "aws://default" } };
    const r = model(
      "",
      {
        bedrock: { destinations: ["bedrock-runtime.us-west-2.amazonaws.com"], ...signed },
        bedrock_control: { destinations: ["bedrock.us-west-2.amazonaws.com"], ...signed },
      },
      { targets: [getBoxGatewayBedrockTargetSpec()] },
    );
    expect(r.targets()).toEqual([
      "bedrock-runtime.us-west-2.amazonaws.com -> bedrock",
      "bedrock.us-west-2.amazonaws.com -> egress-bedrock-control",
    ]);
    expect(r.failures()).toEqual([]);
  });

  test("refuses an entry for a default target's endpoint whose secret differs", () => {
    const r = model(
      "",
      {
        models: {
          destinations: ["bedrock-runtime.us-west-2.amazonaws.com"],
          secret: { ref: "env://KEY" },
        },
      },
      { targets: [getBoxGatewayBedrockTargetSpec()] },
    );
    expect(r.failures()).toEqual([["EXISTING_TARGET_CONFLICT", "models"]]);
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

  test("names a permit whose path tests build cannot check together, and keeps its host", () => {
    const many = [..."abcdefghijklm"].map((c) => `context.input.path like "*${c}*"`).join(" && ");
    const r = model(reach("many", "x.example.com", many));
    expect(r.failures()).toEqual([]);
    expect(r.targets()).toEqual(["x.example.com -> egress-x-example-com"]);
    expect(r.network.warnings[0]).toBe(
      '.box/agent/local/policy.dw:2:1: The rule "many" has more path conditions than build can ' +
        "check together, so build cannot tell whether your policy allows a request to " +
        "x.example.com. Build gives the host a gateway target, and Box still applies the rule.",
    );
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
    const control = passthrough("egress-control", "https://bedrock.us-west-2.amazonaws.com", {
      outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "bedrock", region: "us-west-2" },
    });
    // A Memory target of the user: build writes no policy file for one.
    const memory = passthrough("agentcore", "https://bedrock-agentcore.us-west-2.amazonaws.com", {
      outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "bedrock-agentcore", region: "us-west-2" },
    });
    const r = model("", egress, { targets: [control] });
    expect(boxGatewayIamWarnings(r.spec, r.network)).toEqual([
      "Target 'egress-control' calls bedrock with the gateway's role, which has no bedrock " +
        "permissions. Add an IAM policy file to additionalPolicies of the 'agent-box-egress' gateway.",
    ]);
    const unlisted = model("", egress, { targets: [memory] });
    expect(boxGatewayIamWarnings(unlisted.spec, unlisted.network)).toEqual([
      "Target 'agentcore' calls bedrock-agentcore with the gateway's role, which has no " +
        "bedrock-agentcore permissions. Add an IAM policy file to additionalPolicies of the " +
        "'agent-box-egress' gateway.",
    ]);
    // The model calls' grants allow the runtime host, not the control plane.
    const controlWarning =
      "Target 'egress-control' calls bedrock.us-west-2.amazonaws.com with the gateway's role, " +
      "which has no bedrock permissions for that host. Add an IAM policy file to " +
      "additionalPolicies of the 'agent-box-egress' gateway.";
    const granted = model("", egress, {
      targets: [control],
      grantedActions: ["bedrock:InvokeModel"],
    });
    expect(boxGatewayIamWarnings(granted.spec, granted.network)).toEqual([controlWarning]);
    const listed = model("", egress, { targets: [getBoxGatewayBedrockTargetSpec(), control] });
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
      "'agent-box-egress' gateway.";
    const forService = (target: string, service: string) =>
      `Target '${target}' calls ${service} with the gateway's role, which has no ${service} ` +
      "permissions. Add an IAM policy file to additionalPolicies of the 'agent-box-egress' gateway.";

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

    test("a Bedrock runtime target needs bedrock:InvokeModel, which the Bedrock file grants in the build region only", () => {
      expect(warningsFor(runtime, [], [BEDROCK_FILE])).toEqual([]);
      expect(warningsFor(getBoxGatewayBedrockTargetSpec(), [], [BEDROCK_FILE])).toEqual([]);
      expect(warningsFor(getBoxGatewayBedrockTargetSpec("us-east-1"), [], [BEDROCK_FILE])).toEqual([
        forHost("bedrock", "bedrock-runtime.us-east-1.amazonaws.com", "bedrock"),
      ]);
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

    test("an S3 target needs an S3 grant that the user adds, and build adds none", () => {
      const bucket = signed("egress-s3", "s3.us-west-2.amazonaws.com", "s3");
      expect(warningsFor(bucket)).toEqual([forService("egress-s3", "s3")]);
      expect(warningsFor(bucket, [], [BEDROCK_FILE])).toEqual([forService("egress-s3", "s3")]);
      expect(warningsFor(bucket, ["s3:GetObject"])).toEqual([]);
    });

    test("a Bedrock target outside the managed endpoints needs a granted action, and the Bedrock file does not count", () => {
      const KB_HOST = "bedrock-agent-runtime.us-west-2.amazonaws.com";
      const kb = signed("egress-kb", KB_HOST, "bedrock");
      expect(warningsFor(kb, [], [BEDROCK_FILE])).toEqual([
        forHost("egress-kb", KB_HOST, "bedrock"),
      ]);
      expect(warningsFor(kb)).toEqual([forService("egress-kb", "bedrock")]);
      expect(warningsFor(kb, ["bedrock:Retrieve"], [BEDROCK_FILE])).toEqual([]);
      const API_HOST = "bedrock-runtime.us-east-1.api.aws";
      const api = signed("egress-api", API_HOST, "bedrock");
      expect(warningsFor(api, [], [BEDROCK_FILE])).toEqual([
        forHost("egress-api", API_HOST, "bedrock"),
      ]);
    });

    test("an AgentCore target needs an AgentCore grant", () => {
      const memory = signed(
        "agentcore",
        "bedrock-agentcore.us-west-2.amazonaws.com",
        "bedrock-agentcore",
      );
      expect(warningsFor(memory)).toEqual([forService("agentcore", "bedrock-agentcore")]);
      expect(warningsFor(memory, ["bedrock-agentcore:*"])).toEqual([]);
      expect(warningsFor(agentcoreControl, ["bedrock-agentcore:*"])).toEqual([]);
      expect(warningsFor(agentcoreControl)).toEqual([
        forService("egress-agentcore-control", "bedrock-agentcore"),
      ]);
    });

    test("the Bedrock file grants the amazonaws.com.cn host of a build for China", () => {
      const china = (name: string, host: string, service: string) =>
        passthrough(name, `https://${host}`, {
          outboundAuth: { type: "GATEWAY_IAM_ROLE", service, region: "cn-north-1" },
        });
      const r = model(
        "",
        {},
        {
          targets: [
            china("egress-models", "bedrock-runtime.cn-north-1.amazonaws.com.cn", "bedrock"),
          ],
        },
      );
      r.spec.agentCoreGateways[0]!.additionalPolicies = [BEDROCK_FILE];

      expect(boxGatewayIamWarnings(r.spec, { ...r.network, region: "cn-north-1" })).toEqual([]);
    });
  });
});

describe("the gateways of the project", () => {
  const TOOLS = { name: "tools", authorizerType: "AWS_IAM", targets: [] };
  const OPEN = { name: "open-tools", authorizerType: "NONE", targets: [] };
  const JWT = { name: "jwt-tools", authorizerType: "CUSTOM_JWT", targets: [] };
  const OTHER_BOX = { ...boxGatewaySpec("other"), targets: [] };

  test("gives the agent each gateway without boundRuntime, with its target and its variables", () => {
    const { network } = model("", {}, { gateways: [TOOLS, OPEN, OTHER_BOX] });

    expect(network.projectGateways).toEqual([
      {
        name: "tools",
        target: "egress-gateway-tools",
        variablePrefix: "AGENTCORE_GATEWAY_TOOLS",
        auth: "iam",
      },
      {
        name: "open-tools",
        target: "egress-gateway-open-tools",
        variablePrefix: "AGENTCORE_GATEWAY_OPEN_TOOLS",
        auth: "none",
      },
    ]);
    expect(network.failures).toEqual([]);
  });

  test.each([
    [
      { accepts: false, reason: "refuses" },
      "the @aws/agentcore-cdk in agentcore/cdk does not accept passthrough.gateway. Update " +
        "@aws/agentcore-cdk in agentcore/cdk/package.json to a version that accepts it, then " +
        "build again.",
    ],
    [
      { accepts: false, reason: "not-installed" },
      "build found no @aws/agentcore-cdk in agentcore/cdk. Run npm install in agentcore/cdk, " +
        "then build again.",
    ],
    [
      { accepts: false, reason: "no-node" },
      "build cannot run node to check the @aws/agentcore-cdk in agentcore/cdk. Put node on " +
        "PATH, then build again.",
    ],
    [
      { accepts: false, reason: "timed-out" },
      "the check of the @aws/agentcore-cdk in agentcore/cdk took more than 60 seconds. Build " +
        "again.",
    ],
    [
      { accepts: false, reason: "failed", detail: "the library is broken" },
      "the check of the @aws/agentcore-cdk in agentcore/cdk failed: the library is broken. " +
        "Build again.",
    ],
  ] as const)(
    "gives the agent no gateway, and one warning that says why, when the check gives %o",
    (projectGatewayCheck, why) => {
      const { network } = model("", {}, { gateways: [TOOLS, OPEN], projectGatewayCheck });

      expect(network.projectGateways).toEqual([]);
      expect(network.failures).toEqual([]);
      expect(network.warnings).toEqual([
        "The gateways 'tools' and 'open-tools' of this project get no route for a boxed agent " +
          `on AgentCore Runtime, because ${why}`,
      ]);
    },
  );

  test("gives a PRIVATE_VPC runtime no gateway, as the CDK library binds none to it", () => {
    const { network } = model(
      "",
      {},
      { gateways: [TOOLS], runtime: { containment: "PRIVATE_VPC" } },
    );

    expect(network.projectGateways).toEqual([]);
  });

  test("gives the agent no route to a CUSTOM_JWT gateway, and no warning on each build", () => {
    const { network } = model("", {}, { gateways: [JWT] });

    expect(network.projectGateways).toEqual([]);
    expect(network.warnings).toEqual([]);
  });

  test("fails a gateway whose target has the name of the target that a host takes again", () => {
    // An earlier build wrote egress-gateway-tools for [egress.gateway-tools]; then the gateway
    // tools came, and build gives it that name too.
    const held = passthrough("egress-gateway-tools", "https://api.github.com");
    const r = model(
      "",
      { "gateway-tools": { destinations: ["api.github.com"] } },
      { gateways: [TOOLS], targets: [held] },
    );

    expect(r.failures()).toEqual([["TARGET_NAME_COLLISION", "gateway-tools"]]);
    expect(r.reasons()[0]).toContain(
      "takes the gateway target 'egress-gateway-tools' for api.github.com, and the target that " +
        "build adds for the gateway 'tools' has that name.",
    );
  });

  test("owns the target of each gateway, so the record lists it", () => {
    const { network } = model("", {}, { gateways: [TOOLS], ownedTargets: new Set() });

    expect([...network.managedTargets]).toEqual(["egress-gateway-tools"]);
  });

  test("fails a gateway whose target has the name of a target that build does not own", () => {
    const mine = passthrough("egress-gateway-tools", "https://mine.example.com");
    const r = model("", {}, { gateways: [TOOLS], targets: [mine], ownedTargets: new Set() });

    expect(r.failures()).toEqual([["TARGET_NAME_COLLISION", "egress-gateway-tools"]]);
    expect(r.reasons()).toEqual([
      "The gateway 'tools' of this project would get the gateway target 'egress-gateway-tools', " +
        "and the gateway target 'egress-gateway-tools' has that name. Rename that target.",
    ]);
  });

  test("fails two gateways whose targets still have one name, as for two hosts", () => {
    // The target of "a--b" ends in the hash of its name, which a second gateway can have as a name.
    const hash = createHash("sha256").update("a--b").digest("hex").slice(0, 8);
    const first = { name: "a--b", authorizerType: "AWS_IAM", targets: [] };
    const second = { name: `a-b-${hash}`, authorizerType: "AWS_IAM", targets: [] };
    const r = model("", {}, { gateways: [first, second] });

    expect(r.failures()).toEqual([["TARGET_NAME_COLLISION", `egress-gateway-a-b-${hash}`]]);
    expect(r.reasons()).toEqual([
      `The gateways 'a--b' and 'a-b-${hash}' of this project would both get the gateway target ` +
        `'egress-gateway-a-b-${hash}'. Rename one of the gateways.`,
    ]);
  });

  test("fails an entry whose target would take the name of a gateway's target", () => {
    const r = model(
      "",
      { "gateway-tools": { destinations: ["x.example.com"] } },
      { gateways: [TOOLS] },
    );

    expect(r.failures()).toEqual([["TARGET_NAME_COLLISION", "gateway-tools"]]);
    expect(r.reasons()[0]).toContain("the target that build adds for the gateway 'tools'");
  });

  test("keeps the target that build wrote for a gateway as build's own", () => {
    const written = {
      name: "egress-gateway-tools",
      targetType: "passthrough",
      passthrough: { gateway: "tools", protocolType: "CUSTOM" },
      outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "bedrock-agentcore" },
    } as AgentCoreGatewayTarget;

    expect(model("", {}, { gateways: [TOOLS], targets: [written] }).failures()).toEqual([]);
  });

  test("counts the gateways' targets toward the limit of 100", () => {
    const egress = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`h${i}`, { destinations: [`h${i}.example.com`] }]),
    );
    const r = model("", egress, { gateways: [TOOLS] });

    expect(r.reasons()).toEqual([
      "The gateway 'agent-box-egress' needs 101 targets, 100 for the hosts of the Box profile, 1 " +
        "for the gateways of the project, and 0 of your own, and a gateway can have at most 100. " +
        "Remove hosts from the profile, or targets from the gateway.",
    ]);
  });

  test.each([
    [
      "an [egress] entry",
      { tools: { destinations: [GATEWAY_HOST], secret: { ref: "aws://" } } },
      {},
    ],
    [
      "an HTTP [mcp] server",
      {},
      { mcp: { tools: { type: "http", destinations: [GATEWAY_HOST], secret: { ref: "aws://" } } } },
    ],
  ])(
    "refuses %s that signs for a gateway host, and names the route build adds",
    (_, egress, options) => {
      const r = model("", egress, { ...options, gateways: [TOOLS] });

      expect(r.failures().map(([code]) => code)).toEqual(["UNSIGNABLE_HOST"]);
      expect(r.reasons()[0]).toContain(
        `signs requests to ${GATEWAY_HOST}, the host of an AgentCore gateway, with aws://. Build ` +
          "signs only for the gateways of this project, and it adds the route to each of them on " +
          "AgentCore Runtime itself, as [mcp.<gateway name>]",
      );
    },
  );
});

const GATEWAY_HOST =
  "other-project-tools-abcdefghij.gateway.bedrock-agentcore.us-west-2.amazonaws.com";

describe("boxGatewayIamWarnings for a gateway of the project", () => {
  test("gives no warning for a target that names a gateway, which the CDK library grants", () => {
    const spec = {
      name: "demo",
      projectType: "box",
      runtimes: [RUNTIME],
      agentCoreGateways: [
        {
          ...boxGatewaySpec("agent"),
          targets: [
            {
              name: "egress-gateway-tools",
              targetType: "passthrough",
              passthrough: { gateway: "tools", protocolType: "CUSTOM" },
              outboundAuth: {
                type: "GATEWAY_IAM_ROLE",
                service: "bedrock-agentcore",
                region: "us-west-2",
              },
            },
          ],
        },
        { name: "tools", authorizerType: "AWS_IAM", targets: [] },
      ],
    } as unknown as ProjectSpec;

    expect(
      boxGatewayIamWarnings(spec, {
        runtime: "agent",
        gateway: "agent-box-egress",
        grantedActions: [],
        region: "us-west-2",
      }),
    ).toEqual([]);
  });

  test("warns for a target to a gateway host that the role has no InvokeGateway for", () => {
    const spec = {
      name: "demo",
      projectType: "box",
      runtimes: [RUNTIME],
      agentCoreGateways: [
        {
          ...boxGatewaySpec("agent"),
          targets: [
            passthrough("mine", `https://${GATEWAY_HOST}`, {
              outboundAuth: {
                type: "GATEWAY_IAM_ROLE",
                service: "bedrock-agentcore",
                region: "us-west-2",
              },
            }),
          ],
        },
      ],
    } as unknown as ProjectSpec;
    const network = { runtime: "agent", gateway: "agent-box-egress", region: "us-west-2" };

    // The role holds an AgentCore grant, but not InvokeGateway on that gateway.
    expect(
      boxGatewayIamWarnings(spec, { ...network, grantedActions: ["bedrock-agentcore:ListEvents"] }),
    ).toEqual([
      `Target 'mine' calls ${GATEWAY_HOST} with the gateway's role, which has no bedrock-agentcore ` +
        "permissions for that host. Add an IAM policy file to additionalPolicies of the " +
        "'agent-box-egress' gateway.",
    ]);
    expect(
      boxGatewayIamWarnings(spec, {
        ...network,
        grantedActions: ["bedrock-agentcore:InvokeGateway"],
      }),
    ).toEqual([]);
  });
});
