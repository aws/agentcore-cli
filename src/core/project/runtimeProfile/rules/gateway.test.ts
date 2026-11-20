import { describe, expect, test } from "bun:test";
import { parse } from "smol-toml";
import { InputValidationError } from "../../../../errors/errors";
import {
  getBoxGatewayAgentCoreTargetSpec,
  getBoxGatewayBedrockTargetSpec,
} from "../../../../handlers/project/shortcuts";
import type { AgentCoreGatewayTarget } from "../../../../projectSchemas/gateway";
import { boxGatewaySpec, type ProjectSpec } from "../../../../projectSchemas/project";
import type { ProjectRuntime } from "../../../../projectSchemas/runtime";
import {
  buildBoxNetwork,
  parseResolvedPolicy,
  profilePlaces,
  type BoxHostSource,
  type BoxNetworkHost,
} from "../../boxNetwork";
import { addBoxGatewayTargets } from "../../boxMemory";
import {
  boxNetworkEdits,
  credentialsWriter,
  defaultTargetsWriter,
  gatewayTargetsWriter,
} from "../../boxNetworkWriters";
import { boxNetworkRules } from "../../boxProfileResolver-test-support";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { profileKeyPlaces, runtimeProfileContext } from "../context";
import { deriveRuntimeProfile } from "../derive";
import { serializeRuntimeProfile } from "../serialize";
import type { TomlTable } from "../types";
import { apply } from "./gateway";

const PROFILE = ".box/agent/local/profile.toml";
const GATEWAY = "agent-box-egress";
const RUNTIME = {
  name: "agent",
  build: "CodeZip",
  entrypoint: "start.py",
  codeLocation: "app/agent",
  protocol: "HTTP",
  modelProvider: "Bedrock",
  box: { version: "1.0.0" },
} as ProjectRuntime;

/** A Box project whose runtime `agent` has its Box gateway, with `targets`, and `memories`. */
function project(targets: AgentCoreGatewayTarget[] = [], memories: string[] = []): ProjectSpec {
  return {
    name: "demo",
    projectType: "box",
    runtimes: [RUNTIME],
    memories: memories.map((name) => ({ name, eventExpiryDuration: 30, strategies: [] })),
    credentials: [],
    agentCoreGateways: [{ ...boxGatewaySpec("agent"), targets }],
  } as unknown as ProjectSpec;
}

const passthrough = (name: string, endpoint: string): AgentCoreGatewayTarget => ({
  name,
  targetType: "passthrough",
  passthrough: { endpoint, protocolType: "CUSTOM" },
});

/** A host of the Box network model, named by `source`, with its gateway target if it has one. */
function host(
  authority: string,
  source: BoxHostSource | undefined,
  target?: string,
): BoxNetworkHost {
  const [name, port] = authority.split(":");
  return {
    host: name!,
    ...(port !== undefined && { port: Number(port) }),
    authority,
    sources: source ? [source] : [],
    outboundAuth: { kind: "none" },
    reachable: target !== undefined,
    ...(target !== undefined && { target }),
    allowed: target === undefined ? 0 : 3,
    samples: 3,
    forbiddenBy: target === undefined ? ["deny_all"] : [],
    enforcedByBox: [],
  };
}
const entry = (name: string, ...destinations: string[]): BoxHostSource => ({
  kind: "entry",
  egressEntry: name,
  destinations,
});
const server = (
  name: string,
  destination: string,
  secret?: Extract<BoxHostSource, { kind: "mcp" }>["secret"],
): BoxHostSource => ({
  kind: "mcp",
  mcpEntry: name,
  destinations: [destination],
  ...(secret && { secret }),
});

/** The context of the derivation for the local profile `text`, the model's `hosts`, and `targets`. */
function contextOf(
  text: string,
  hosts: BoxNetworkHost[],
  targets: AgentCoreGatewayTarget[] = [],
  region = "us-west-2",
) {
  return runtimeProfileContext({
    spec: project(targets),
    runtime: RUNTIME,
    profileFile: PROFILE,
    region,
    gateway: { name: GATEWAY, targets },
    hosts,
    telemetry: [],
    places: profileKeyPlaces(text, PROFILE),
  });
}

/** What the gateway rule makes of the local profile `text`. */
function gateway(
  text: string,
  hosts: BoxNetworkHost[],
  targets: AgentCoreGatewayTarget[] = [],
  region?: string,
) {
  return apply(parse(text) as TomlTable, contextOf(text, hosts, targets, region));
}

/**
 * The TOML text of one route's gateway backend, under the table `table`: signed for the Runtime's
 * own region, which box reads from the `aws.region` input, whatever region build builds for.
 */
const backendText = (table: string, target: string) =>
  `[[${table}.backends]]\n` +
  `url = "\${{ inputs.gateway.url }}/${target}"\n` +
  'auth.ref = "aws://"\n' +
  'auth.aws.service = "bedrock-agentcore"\n' +
  'auth.aws.region = "${{ inputs.aws.region }}"\n';

describe("the gateway rule", () => {
  test("carries each key it does not own, and a stdio [mcp] server, as the local profile has them", () => {
    const text = [
      'packs = ["@box/base", "team/search"]',
      'agent-args = ["--verbose"]',
      'unknown-key = "box refuses it locally first"',
      "[agent]",
      'command = ["/bin/echo"]',
      "[mcp.notes]",
      'type = "stdio"',
      'command = ["${{ workspace }}/app/agent/notes"]',
      "[mcp.notes.network]",
      "contain_egress = false",
      "[telemetry.records]",
      'kind = "file"',
      'destination = "/tmp/records.jsonl"',
    ].join("\n");

    const { table, problems } = gateway(text, []);

    expect(problems).toEqual([]);
    expect(table).toEqual(parse(text));
  });

  test("sends each host of an [egress] entry to its gateway target, and keeps its other keys", () => {
    const text = [
      'packs = ["@box/base"]',
      "[egress.github]",
      'destinations = ["api.github.com"]',
      'protocol = "http"',
      'x-later-key = "kept"',
      'secret.ref = "env://GITHUB_TOKEN"',
    ].join("\n");

    const { table, problems } = gateway(text, [
      host("api.github.com", entry("github", "api.github.com"), "egress-github"),
    ]);

    expect(problems).toEqual([]);
    // The secret moves to the gateway target, which sends the key.
    expect(table).toEqual(
      parse(
        'packs = ["@box/base"]\n' +
          // The route keeps the name of its entry; its backend names the target.
          "[egress.github]\n" +
          'destinations = ["api.github.com"]\n' +
          'protocol = "http"\n' +
          'x-later-key = "kept"\n' +
          backendText("egress.github", "egress-github"),
      ),
    );
  });

  test.each([
    ["that a pack adds", 'packs = ["@box/base", "@box/anthropic"]\n'],
    [
      "that the profile changes",
      'packs = ["@box/base", "@box/anthropic"]\n[egress.anthropic]\nsecret.ref = "env://MY_KEY"\n',
    ],
  ])(
    "gives the route of an entry %s the name of the entry, so the table of the pack merges with it",
    (_label, text) => {
      const { table } = gateway(text, [
        host("api.anthropic.com", entry("anthropic", "api.anthropic.com"), "egress-anthropic"),
      ]);

      // A route under the target's name beside the pack's own [egress.anthropic] would be a second
      // route to api.anthropic.com, which box refuses.
      expect(table.egress).toEqual(
        parse(
          '[egress.anthropic]\ndestinations = ["api.anthropic.com"]\n' +
            backendText("egress.anthropic", "egress-anthropic"),
        ).egress,
      );
    },
  );

  test("names a route after its target when a target of the entry's name serves another host", () => {
    const { table } = gateway(
      '[egress.orders]\ndestinations = ["api.example.com"]\n',
      [host("api.example.com", entry("orders", "api.example.com"), "egress-orders")],
      [passthrough("orders", "https://orders.example.com")],
    );

    expect(Object.keys(table.egress as TomlTable).sort()).toEqual(["egress-orders", "orders"]);
  });

  test("gives each host of an entry with several destinations its own route, signed for the Runtime's region and not the build region", () => {
    const text =
      '[egress.models]\ndestinations = ["api.one.example.com", "api.two.example.com:8443/v1"]\n';

    const { table } = gateway(
      text,
      [
        host("api.one.example.com", entry("models", "api.one.example.com"), "egress-models-one"),
        host(
          "api.two.example.com:8443",
          entry("models", "api.two.example.com:8443/v1"),
          "egress-models-two",
        ),
      ],
      [],
      "eu-central-1",
    );

    expect(table.egress).toEqual(
      parse(
        '[egress.egress-models-one]\ndestinations = ["api.one.example.com"]\n' +
          backendText("egress.egress-models-one", "egress-models-one") +
          // The route keeps the port of the target's endpoint, and no path.
          '[egress.egress-models-two]\ndestinations = ["api.two.example.com:8443"]\n' +
          backendText("egress.egress-models-two", "egress-models-two"),
      ).egress,
    );
  });

  test("adds a route for each target that no entry names, and none for a target build removes", () => {
    const targets = [
      passthrough("orders", "https://orders.example.com/v2"),
      getBoxGatewayBedrockTargetSpec(),
      getBoxGatewayAgentCoreTargetSpec(),
      // An earlier build wrote this target, and no host of the profile takes it now.
      passthrough("egress-old", "https://old.example.com"),
      { name: "lambda", targetType: "lambda" } as unknown as AgentCoreGatewayTarget,
    ];
    const text = '[egress.bedrock]\nsecret.ref = "aws://default"\n';

    const { table } = gateway(
      text,
      [
        host("bedrock-runtime.us-west-2.amazonaws.com", entry("bedrock"), "bedrock"),
        // A host that only a permit names, which gets a target build adds.
        host("httpbin.org", { kind: "rule", ruleId: "httpbin_get" }, "egress-httpbin-org"),
      ],
      targets,
    );

    expect(table.egress).toEqual(
      parse(
        '[egress.bedrock]\ndestinations = ["bedrock-runtime.us-west-2.amazonaws.com"]\n' +
          backendText("egress.bedrock", "bedrock") +
          '[egress.orders]\ndestinations = ["orders.example.com"]\n' +
          backendText("egress.orders", "orders") +
          '[egress.agentcore]\ndestinations = ["bedrock-agentcore.us-west-2.amazonaws.com"]\n' +
          backendText("egress.agentcore", "agentcore") +
          '[egress.egress-httpbin-org]\ndestinations = ["httpbin.org"]\n' +
          backendText("egress.egress-httpbin-org", "egress-httpbin-org"),
      ).egress,
    );
  });

  test("removes an entry whose hosts the policy denies, for which the Box network model warns", () => {
    const text = '[egress.blocked]\ndestinations = ["blocked.example.com"]\n';

    const { table, problems, warnings } = gateway(text, [
      host("blocked.example.com", entry("blocked", "blocked.example.com")),
    ]);

    expect(table.egress).toBeUndefined();
    expect(problems).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("refuses two passthrough targets for one host, which would give two routes to it", () => {
    const targets = [
      passthrough("github", "https://api.github.com"),
      passthrough("github-v2", "https://api.github.com/v2"),
    ];

    expect(() => gateway("", [], targets)).toThrow(
      new InputValidationError(
        "gateway 'agent-box-egress' has two passthrough targets for api.github.com, 'github' and " +
          "'github-v2', so runtime 'agent' would get two routes to one host. Remove one of them.",
      ),
    );
  });

  test("changes no table it gets", () => {
    const text =
      '[egress.github]\ndestinations = ["api.github.com"]\nsecret.ref = "env://GITHUB_TOKEN"\n' +
      '[mcp.docs]\ntype = "http"\ndestinations = ["docs.example.com"]\nsecret.ref = "env://DOCS"\n';
    const local = parse(text) as TomlTable;
    const frozen = structuredClone(local);

    apply(
      local,
      contextOf(text, [
        host("api.github.com", entry("github", "api.github.com"), "egress-github"),
        host("docs.example.com", server("docs", "docs.example.com"), "egress-docs"),
      ]),
    );

    expect(local).toEqual(frozen);
  });
});

describe("the gateway rule for an HTTP [mcp] server", () => {
  const DOCS_SECRET = {
    ref: "env://DOCS_TOKEN",
    header: "x-api-key",
    phantom_prefix: "dk-",
    inject: "always",
  };
  const DOCS = [
    "[mcp.docs]",
    'type = "http"',
    'destinations = ["docs.example.com"]',
    'description = "kept"',
    'secret.ref = "env://DOCS_TOKEN"',
    'secret.header = "x-api-key"',
    'secret.phantom_prefix = "dk-"',
    'secret.inject = "always"',
  ].join("\n");

  test("keeps the server's name and other keys, gives it its gateway backend, and keeps its env:// secret", () => {
    const { table, problems } = gateway(DOCS, [
      host("docs.example.com", server("docs", "docs.example.com", DOCS_SECRET), "egress-docs"),
    ]);

    expect(problems).toEqual([]);
    // The agent keeps its stand-in, the gateway sends the key, and Box refuses inject beside a backend.
    expect(table).toEqual(
      parse(
        '[mcp.docs]\ntype = "http"\ndestinations = ["docs.example.com"]\ndescription = "kept"\n' +
          'secret.ref = "env://DOCS_TOKEN"\nsecret.header = "x-api-key"\n' +
          'secret.phantom_prefix = "dk-"\n' +
          backendText("mcp.docs", "egress-docs"),
      ),
    );
    expect(table.egress).toBeUndefined();
  });

  test("keeps no secret that signs, as Box refuses a signed secret beside a backend", () => {
    const text = '[mcp.docs]\ntype = "http"\ndestinations = ["docs.example.com"]\n';

    const { table } = gateway(text, [
      host(
        "docs.example.com",
        server("docs", "docs.example.com", { ref: "aws://default" }),
        "egress-docs",
      ),
    ]);

    expect(table.mcp).toEqual(
      parse(
        '[mcp.docs]\ntype = "http"\ndestinations = ["docs.example.com"]\n' +
          backendText("mcp.docs", "egress-docs"),
      ).mcp,
    );
  });

  test("writes a target that serves a server that only a pack declares as that server", () => {
    const { table } = gateway(
      "",
      [host("docs.example.com", server("docs", "docs.example.com"), "docs")],
      [passthrough("docs", "https://docs.example.com")],
    );

    expect(table.egress).toBeUndefined();
    expect(table.mcp).toEqual(
      parse(
        '[mcp.docs]\ntype = "http"\ndestinations = ["docs.example.com"]\n' +
          backendText("mcp.docs", "docs"),
      ).mcp,
    );
  });

  test("removes a server whose host the policy denies, for which the Box network model warns", () => {
    const text = '[mcp.denied]\ntype = "http"\ndestinations = ["denied.example.com"]\n';

    const { table, problems } = gateway(text, [
      host("denied.example.com", server("denied", "denied.example.com")),
    ]);

    expect(table.mcp).toBeUndefined();
    expect(problems).toEqual([]);
  });
});

/**
 * One project, given to the old renderer and to the derivation: the local profile's own text, what
 * Box resolves it to, and the policy. The Runtime profile that staging renders today, from
 * agentcore.json as build writes it, has the same `[egress]` and HTTP `[mcp]` tables as the
 * profile that build derives from the local profile.
 */
/**
 * The `[egress]` and HTTP `[mcp]` tables that the Runtime renderer that the derivation replaced
 * wrote for each case below, recorded before that renderer was deleted.
 */
const OLD_RENDERER = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "__fixtures__", "old-renderer-tables.json"), "utf8"),
).gateway as Record<string, { egress: TomlTable | null; mcp: TomlTable }>;

/** The tables of the old renderer for `label`, as parse gives them. */
function rendered(label: string): TomlTable {
  const { egress, mcp } = OLD_RENDERER[label]!;
  return { ...(egress && { egress }), ...(Object.keys(mcp).length > 0 && { mcp }) };
}

/**
 * The `[egress]` routes of the old renderer under the keys that the gateway rule gives them: the
 * old renderer named each route after its target, and the rule names the route of an entry with one
 * host after the entry, so that a pack table of that name merges with it. The routes are the same.
 */
const withEntryKeys = (egress: unknown) =>
  Object.fromEntries(
    Object.entries(egress as TomlTable).map(([key, route]) => [
      key === "egress-github" ? "github" : key,
      route,
    ]),
  );

describe("the gateway rule and the Runtime renderer it replaced", () => {
  const TEXT = [
    'packs = ["@box/base", "@box/bedrock"]',
    'policies = ["policy.dw"]',
    "",
    "[agent]",
    'command = ["${{ workspace }}/app/agent/run"]',
    "",
    "[egress.bedrock]",
    'secret.ref = "aws://default"',
    "",
    "[egress.github]",
    'destinations = ["api.github.com"]',
    'secret.ref = "env://GITHUB_TOKEN"',
    "",
    "[egress.models]",
    'destinations = ["api.one.example.com", "api.two.example.com"]',
    "",
    "[egress.blocked]",
    'destinations = ["blocked.example.com"]',
    "",
    "[mcp.docs]",
    'type = "http"',
    'destinations = ["docs.example.com"]',
    'secret.ref = "env://DOCS_TOKEN"',
    'secret.header = "x-api-key"',
    "",
    "[mcp.notes]",
    'type = "stdio"',
    'command = ["${{ workspace }}/app/agent/notes"]',
  ].join("\n");
  /** The `[egress]` and `[mcp]` tables that Box resolves the profile to, with @box/bedrock. */
  const EGRESS = {
    bedrock: {
      destinations: ["bedrock-runtime.us-west-2.amazonaws.com"],
      secret: { ref: "aws://default" },
    },
    github: { destinations: ["api.github.com"], secret: { ref: "env://GITHUB_TOKEN" } },
    models: { destinations: ["api.one.example.com", "api.two.example.com"] },
    blocked: { destinations: ["blocked.example.com"] },
  };
  const MCP = {
    docs: {
      type: "http",
      destinations: ["docs.example.com"],
      secret: { ref: "env://DOCS_TOKEN", header: "x-api-key" },
    },
    notes: { type: "stdio", command: ["/project/app/agent/notes"] },
  };
  const HR = 'action == Box::Action::"http:request"';
  const NC = 'action == Box::Action::"net:connect"';
  const POLICY =
    `@id("no_blocked") forbid (principal, ${HR}, resource) when { context.input.host == "blocked.example.com" };\n` +
    `@id("httpbin_connect") permit (principal, ${NC}, resource) when { context.input.host == "httpbin.org" };\n` +
    `@id("httpbin_get") permit (principal, ${HR}, resource) when { context.input.host == "httpbin.org" && context.input.path == "/get" };\n`;
  const TARGETS = [
    // The user's own target, which no host of the profile takes.
    passthrough("orders", "https://orders.example.com"),
    // A target an earlier build wrote for a host the profile no longer names.
    passthrough("egress-old", "https://old.example.com"),
  ];

  /** A local profile: its text, the tables Box resolves it to, and its policy. */
  interface Fixture {
    readonly text: string;
    readonly egress: Record<string, unknown>;
    readonly mcp: Record<string, unknown>;
    readonly policy: string;
  }
  const FIXTURE: Fixture = { text: TEXT, egress: EGRESS, mcp: MCP, policy: POLICY };

  /**
   * What staging renders today for `spec`, from agentcore.json as build then writes it, and what
   * build derives from the local profile for it.
   */
  function bothProfiles(spec: ProjectSpec, { text, egress, mcp, policy }: Fixture = FIXTURE) {
    const withDefaults = structuredClone(spec);
    addBoxGatewayTargets(withDefaults, "us-west-2");
    const targets = withDefaults.agentCoreGateways[0]!.targets;
    const { parsed, failures } = parseResolvedPolicy(
      {
        path: PROFILE,
        egress,
        mcp,
        policyFiles: ["policy.dw"],
        places: profilePlaces(text, PROFILE),
        source: {
          table: parse(text) as TomlTable,
          places: profileKeyPlaces(text, PROFILE),
          startFolder: "",
        },
      },
      `${policy}${boxNetworkRules(egress, mcp)}`,
      [{ file: ".box/agent/local/policy.dw", text: policy }],
    );
    const network = buildBoxNetwork(parsed, failures, {
      spec,
      runtime: RUNTIME,
      gateway: GATEWAY,
      region: "us-west-2",
      targets,
      grantedActions: [],
    });
    const written = boxNetworkEdits(
      [credentialsWriter, gatewayTargetsWriter, defaultTargetsWriter],
      [network],
      {
        spec,
        projectRoot: "/project",
        env: { GITHUB_TOKEN: "dummy-github", DOCS_TOKEN: "dummy-docs" },
        envLocal: {},
      },
    ).spec;
    const derived = deriveRuntimeProfile(
      parse(text) as TomlTable,
      runtimeProfileContext({
        spec,
        runtime: RUNTIME,
        profileFile: PROFILE,
        region: "us-west-2",
        gateway: { name: GATEWAY, targets },
        hosts: network.hosts,
        telemetry: [],
        places: profileKeyPlaces(text, PROFILE),
      }),
    );
    return { network, written, derived };
  }
  const http = (mcp: unknown) =>
    Object.fromEntries(
      Object.entries((mcp ?? {}) as TomlTable).filter(
        ([, entry]) => (entry as { type?: unknown }).type === "http",
      ),
    );

  test("give the same [egress] and HTTP [mcp] tables on the first build", () => {
    const { network, derived } = bothProfiles(project(TARGETS, ["agentMemory"]));
    const old = rendered("first build");

    expect(network.failures).toEqual([]);
    expect(derived.problems).toEqual([]);
    expect(Object.keys(old.egress as TomlTable).sort()).toEqual([
      "agentcore",
      "bedrock",
      "egress-github",
      "egress-httpbin-org",
      "egress-models-api-one-example-com",
      "egress-models-api-two-example-com",
      "orders",
    ]);
    expect(Object.keys(http(old.mcp))).toEqual(["docs"]);
    expect(derived.profile.egress).toEqual(withEntryKeys(old.egress));
    expect(http(derived.profile.mcp)).toEqual(http(old.mcp));
    // The model that build keeps holds the same derived profile.
    expect(network.runtimeProfile?.egress).toEqual(withEntryKeys(old.egress));
    expect(http(network.runtimeProfile?.mcp)).toEqual(http(old.mcp));
  });

  test("give the same tables on the next build, from the agentcore.json of the first build", () => {
    const first = bothProfiles(project(TARGETS, ["agentMemory"])).written;
    const { network, derived } = bothProfiles(first);
    const old = rendered("next build");

    expect(network.failures).toEqual([]);
    expect(first.agentCoreGateways[0]!.targets.map(({ name }) => name)).toContain("egress-github");
    expect(derived.profile.egress).toEqual(withEntryKeys(old.egress));
    expect(http(derived.profile.mcp)).toEqual(http(old.mcp));
  });

  test("give the same tables for a target name that TOML must quote, and a port", () => {
    const { derived } = bothProfiles(
      project([passthrough("tools.v2", "https://tools.example.com:8443/api")]),
    );
    const old = rendered("quoted target");

    const quoted = parse(
      '[egress."tools.v2"]\ndestinations = ["tools.example.com:8443"]\n' +
        backendText('egress."tools.v2"', "tools.v2"),
    ).egress as TomlTable;
    expect((old.egress as TomlTable)["tools.v2"]).toEqual(quoted["tools.v2"]);
    expect(derived.profile.egress).toEqual(withEntryKeys(old.egress));
    expect(parse(serializeRuntimeProfile(derived.profile)).egress as unknown).toEqual(
      withEntryKeys(old.egress),
    );
  });

  test("give no second problem for an entry that the Box network model rejects, and no route", () => {
    const text =
      '[egress.wide]\ndestinations = ["*.wide.example.com"]\n' +
      '[mcp.pathed]\ntype = "http"\ndestinations = ["docs.example.com/mcp"]\n';
    const egress = { wide: { destinations: ["*.wide.example.com"] } };
    const mcp = { pathed: { type: "http", destinations: ["docs.example.com/mcp"] } };

    const old = rendered("rejected entries");
    const { network, derived } = bothProfiles(project(), {
      text,
      egress,
      mcp,
      policy: "",
    });

    // The model gives one problem for each entry, where the entry is, and build stops.
    expect(
      network.failures.map(({ code, egressEntry, mcpEntry }) => [code, egressEntry ?? mcpEntry]),
    ).toEqual([
      ["EGRESS_WILDCARD_DESTINATION", "wide"],
      ["MCP_DESTINATION_NOT_ONE_HOST", "pathed"],
    ]);
    expect(derived.problems).toEqual([]);
    expect(derived.profile.egress).toEqual(withEntryKeys(old.egress));
    expect(derived.profile.mcp).toBeUndefined();
    expect(old.mcp).toBeUndefined();
  });
});
