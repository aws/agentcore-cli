import { describe, expect, test } from "bun:test";
import { getBoxGatewayBedrockEntry } from "../../handlers/project/shortcuts";
import type { AgentCoreGatewayTarget } from "../../projectSchemas/gateway";
import type { ProjectSpec } from "../../projectSchemas/project";
import type { BoxNetwork, BoxNetworkHost } from "./boxNetwork";
import { BOX_MEMORY_POLICY_FILE } from "./boxMemory";
import {
  BOX_NETWORK_WRITERS,
  boxNetworkEdits,
  credentialsWriter,
  defaultTargetsWriter,
  gatewayTargetsWriter,
  runtimeProfileWriter,
  type BoxNetworkWriter,
} from "./boxNetworkWriters";

/** A hand-built model of runtime `agent`, which each test changes as it needs. */
function network(overrides: Partial<BoxNetwork> = {}): BoxNetwork {
  return {
    runtime: "agent",
    gateway: "agent-box",
    hosts: [],
    credentials: [],
    policyFiles: [],
    grantedActions: [],
    warnings: [],
    failures: [],
    ...overrides,
  };
}

function host(
  authority: string,
  target: string,
  rest: Partial<BoxNetworkHost> = {},
): BoxNetworkHost {
  return {
    host: authority,
    authority,
    sources: [],
    outboundAuth: { kind: "none" },
    reachable: true,
    target,
    allowed: 1,
    samples: 1,
    forbiddenBy: [],
    enforcedByBox: [],
    ...rest,
  };
}

function spec(targets: AgentCoreGatewayTarget[] = getBoxGatewayBedrockEntry("agent").targets) {
  return {
    name: "demo",
    projectType: "box",
    runtimes: [
      { name: "agent", build: "CodeZip", entrypoint: "start.py", codeLocation: "app/agent" },
    ],
    memories: [],
    credentials: [],
    agentCoreGateways: [{ ...getBoxGatewayBedrockEntry("agent"), targets }],
  } as unknown as ProjectSpec;
}

const passthrough = (name: string, endpoint: string): AgentCoreGatewayTarget => ({
  name,
  targetType: "passthrough",
  passthrough: { endpoint, protocolType: "CUSTOM" },
});

const run = (writers: readonly BoxNetworkWriter[], networks: BoxNetwork[], project = spec()) =>
  boxNetworkEdits(writers, networks, {
    spec: project,
    projectRoot: "/nonexistent/project",
    env: { GITHUB_TOKEN: "ghp_1" },
  });

const targetNames = (project: ProjectSpec) =>
  project.agentCoreGateways[0]!.targets.map(({ name }) => name);

describe("boxNetworkEdits", () => {
  test("refuses two writers that declare one output, naming both", () => {
    expect(() =>
      run([gatewayTargetsWriter, { ...gatewayTargetsWriter, name: "copy" }], [network()]),
    ).toThrow(
      `Box network writers 'gateway targets' and 'copy' both write {"kind":"gatewayTargets","gateway":"agent-box"}`,
    );
  });

  test("changes one copy of the spec, and leaves the spec it was given", () => {
    const project = spec();
    const edits = run(
      BOX_NETWORK_WRITERS,
      [network({ hosts: [host("api.example.com", "egress-api")] })],
      project,
    );

    expect(edits.specChanged).toBe(true);
    expect(targetNames(edits.spec)).toEqual(["bedrock", "egress-api"]);
    expect(targetNames(project)).toEqual(["bedrock"]);
  });

  test("changes nothing when the spec holds what the model gives", () => {
    const models = [network({ hosts: [host("api.example.com", "egress-api")] })];
    const first = run(BOX_NETWORK_WRITERS, models);

    const again = run(BOX_NETWORK_WRITERS, models, first.spec);

    expect(again.specChanged).toBe(false);
    expect(again.messages).toEqual([]);
  });
});

describe("gatewayTargetsWriter", () => {
  test("adds a host's target, rewrites a managed one, removes a stale one, and keeps the user's", () => {
    const project = spec([
      passthrough("bedrock", "https://bedrock-runtime.us-west-2.amazonaws.com"),
      passthrough("egress-github", "https://api.github.com"),
      passthrough("egress-old", "https://old.example.com"),
      passthrough("mine", "https://mine.example.com"),
    ]);
    const models = [
      network({
        hosts: [
          host("api.github.com", "egress-github", {
            outboundAuth: {
              kind: "apiKey",
              credentialName: "github",
              variable: "GITHUB_TOKEN",
              header: "Authorization",
              prefix: "Bearer",
            },
          }),
          host("httpbin.org", "egress-httpbin-org"),
          host("unreached.example.com", "egress-unreached", {
            reachable: false,
            target: undefined,
          }),
        ],
      }),
    ];

    const edits = run([gatewayTargetsWriter], models, project);

    expect(targetNames(edits.spec)).toEqual([
      "bedrock",
      "egress-github",
      "mine",
      "egress-httpbin-org",
    ]);
    expect(edits.spec.agentCoreGateways[0]!.targets[1]!.outboundAuth).toEqual({
      type: "API_KEY",
      credentialName: "github",
      location: "HEADER",
      parameterName: "Authorization",
      prefix: "Bearer",
    });
    expect(edits.messages).toEqual([
      "updating target 'egress-github' of gateway 'agent-box' in agentcore.json, for api.github.com",
      "removing target 'egress-old' from gateway 'agent-box' in agentcore.json: Box allows no request to its host in .box/profile.toml",
      "adding target 'egress-httpbin-org' to gateway 'agent-box' in agentcore.json, for httpbin.org",
    ]);
  });

  test("rewrites a renamed host's managed target in place, with one message", () => {
    const project = spec([passthrough("egress-github", "https://old.example.com")]);

    const edits = run(
      [gatewayTargetsWriter],
      [network({ hosts: [host("api.github.com", "egress-github")] })],
      project,
    );

    expect(edits.messages).toEqual([
      "updating target 'egress-github' of gateway 'agent-box' in agentcore.json, for api.github.com",
    ]);
    expect(edits.spec.agentCoreGateways[0]!.targets).toEqual([
      passthrough("egress-github", "https://api.github.com"),
    ]);
  });

  test("creates the gateway entry only when a host needs a target", () => {
    const empty = { ...spec(), agentCoreGateways: [] } as ProjectSpec;

    expect(run([gatewayTargetsWriter], [network()], empty).specChanged).toBe(false);
    const edits = run(
      [gatewayTargetsWriter],
      [network({ hosts: [host("a.example.com", "egress-a")] })],
      empty,
    );
    expect(edits.messages[0]).toBe("adding gateway 'agent-box' to agentcore.json");
  });
});

describe("credentialsWriter", () => {
  test("declares each credential once and seeds its key from the box variable", () => {
    const credentials = [{ name: "github", variable: "GITHUB_TOKEN" }];
    const edits = run(
      [credentialsWriter],
      [network({ credentials }), network({ runtime: "other", gateway: "other-box", credentials })],
    );

    expect(edits.spec.credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: "github" },
    ]);
    expect(edits.envLocal).toEqual([
      expect.objectContaining({ key: "AGENTCORE_CREDENTIAL_GITHUB", value: "ghp_1" }),
    ]);
  });
});

describe("defaultTargetsWriter", () => {
  test("adds the Memory target and writes its role policy, as addBoxGatewayTargets does", () => {
    const project = spec();
    project.memories.push({
      name: "agentMemory",
      eventExpiryDuration: 30,
      strategies: [],
    } as never);

    const edits = run([defaultTargetsWriter], [network()], project);

    expect(targetNames(edits.spec)).toEqual(["bedrock", "agentcore"]);
    expect(edits.files.map(({ path }) => path)).toEqual([BOX_MEMORY_POLICY_FILE]);
  });

  test("adds no default target for an endpoint a target serves already", () => {
    const project = spec([
      passthrough("egress-models", "https://bedrock-runtime.us-west-2.amazonaws.com"),
    ]);

    expect(run([defaultTargetsWriter], [network()], project).specChanged).toBe(false);
  });

  test("runs after the egress targets, so a new egress- target is not doubled", () => {
    const models = [network({ hosts: [host("api.example.com", "egress-api")] })];

    expect(targetNames(run(BOX_NETWORK_WRITERS, models).spec)).toEqual(["bedrock", "egress-api"]);
  });
});

describe("runtimeProfileWriter", () => {
  test("writes the Runtime profile and a byte copy of each policy file beside it", () => {
    const writer = runtimeProfileWriter([{ runtime: "agent", dist: "app/agent/.box-dist" }]);
    const models = [network({ policyFiles: ["policy.dw", "rules/extra.dw"] })];

    const { files } = run([writer], models);

    expect(writer.writes(models)).toEqual([
      { kind: "file", path: "app/agent/.box-dist/profile.toml" },
      { kind: "file", path: "app/agent/.box-dist/policy.dw" },
      { kind: "file", path: "app/agent/.box-dist/rules/extra.dw" },
    ]);
    expect(files.slice(1)).toEqual([
      { path: "app/agent/.box-dist/policy.dw", copyOf: ".box/policy.dw" },
      { path: "app/agent/.box-dist/rules/extra.dw", copyOf: ".box/rules/extra.dw" },
    ]);
    expect("text" in files[0]! && files[0].text).toContain(
      'policies = ["policy.dw", "rules/extra.dw"]',
    );
  });
});
