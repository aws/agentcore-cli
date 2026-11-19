import { describe, expect, test } from "bun:test";
import { getBoxGatewayAgentCoreTargetSpec } from "../../handlers/project/shortcuts";
import type { AgentCoreGatewayTarget } from "../../projectSchemas/gateway";
import { boxGatewaySpec, type ProjectSpec } from "../../projectSchemas/project";
import type { BoxNetwork, BoxNetworkHost } from "./boxNetwork";
import { BOX_MEMORY_POLICY_FILE } from "./boxMemory";
import {
  BOX_NETWORK_WRITERS,
  boxNetworkEdits,
  credentialsWriter,
  defaultTargetsWriter,
  gatewayTargetsWriter,
  type BoxNetworkWriter,
} from "./boxNetworkWriters";

/** A hand-built model of runtime `agent`, which each test changes as it needs. */
function network(overrides: Partial<BoxNetwork> = {}): BoxNetwork {
  return {
    runtime: "agent",
    gateway: "agent-box-egress",
    hosts: [],
    envRoutes: [],
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

/** The target a user keeps on the Box gateway, which build does not manage. */
const MINE: AgentCoreGatewayTarget = {
  name: "mine",
  targetType: "passthrough",
  passthrough: { endpoint: "https://mine.example.com", protocolType: "CUSTOM" },
};

function spec(targets: AgentCoreGatewayTarget[] = [MINE]) {
  return {
    name: "demo",
    projectType: "box",
    runtimes: [
      { name: "agent", build: "CodeZip", entrypoint: "start.py", codeLocation: "app/agent" },
    ],
    memories: [],
    credentials: [],
    agentCoreGateways: [{ ...boxGatewaySpec("agent"), targets }],
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
    envLocal: {},
  });

const GITHUB_AUTH = {
  kind: "apiKey",
  credentialName: "github",
  variable: "GITHUB_TOKEN",
  header: "Authorization",
  prefix: "Bearer",
} as const;

const targetNames = (project: ProjectSpec) =>
  project.agentCoreGateways[0]!.targets.map(({ name }) => name);

describe("boxNetworkEdits", () => {
  test("refuses two writers that declare one output, naming both", () => {
    expect(() =>
      run([gatewayTargetsWriter, { ...gatewayTargetsWriter, name: "copy" }], [network()]),
    ).toThrow(
      `Box network writers 'gateway targets' and 'copy' both write {"kind":"gatewayTargets","gateway":"agent-box-egress"}`,
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
    expect(targetNames(edits.spec)).toEqual(["mine", "egress-api"]);
    expect(targetNames(project)).toEqual(["mine"]);
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
      passthrough("ours", "https://ours.example.com"),
      passthrough("egress-github", "https://api.github.com"),
      passthrough("egress-old", "https://old.example.com"),
      MINE,
    ]);
    project.credentials.push({ authorizerType: "ApiKeyCredentialProvider", name: "github" });
    const models = [
      network({
        hosts: [
          host("api.github.com", "egress-github", { outboundAuth: GITHUB_AUTH }),
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
      "ours",
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
      "updating gateway target 'egress-github' of 'agent-box-egress' for api.github.com",
      "removing gateway target 'egress-old' from 'agent-box-egress': the Box profile no longer allows old.example.com",
      "adding gateway target 'egress-httpbin-org' to 'agent-box-egress' for httpbin.org",
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
      "updating gateway target 'egress-github' of 'agent-box-egress' for api.github.com",
    ]);
    expect(edits.spec.agentCoreGateways[0]!.targets).toEqual([
      passthrough("egress-github", "https://api.github.com"),
    ]);
  });

  test("writes no target that sends an API key whose credential agentcore.json lacks, and says so", () => {
    const project = spec([MINE, passthrough("egress-github", "https://api.github.com")]);
    const models = [
      network({ hosts: [host("api.github.com", "egress-github", { outboundAuth: GITHUB_AUTH })] }),
    ];

    const edits = run([gatewayTargetsWriter], models, project);

    expect(targetNames(edits.spec)).toEqual(["mine"]);
    expect(edits.messages).toEqual([
      "removing gateway target 'egress-github' of 'agent-box-egress' for api.github.com: it " +
        "sends the key of env://GITHUB_TOKEN, and agentcore.json has no API key credential " +
        "'github' to hold it",
    ]);
    const fresh = run([gatewayTargetsWriter], models);
    expect(fresh.specChanged).toBe(false);
    expect(fresh.messages[0]).toStartWith("not adding gateway target 'egress-github'");
  });

  test("writes to the gateway bound to the runtime, whatever its name", () => {
    const project = spec();
    project.agentCoreGateways[0]!.name = "renamed";

    const edits = run(
      [gatewayTargetsWriter],
      [network({ hosts: [host("a.example.com", "egress-a")] })],
      project,
    );

    expect(edits.messages).toEqual([
      "adding gateway target 'egress-a' to 'renamed' for a.example.com",
    ]);
  });
});

describe("credentialsWriter", () => {
  test("declares each credential once and seeds its key from the box variable", () => {
    const envRoutes = [{ route: "github", variable: "GITHUB_TOKEN" }];
    const edits = run(
      [credentialsWriter],
      [
        network({ envRoutes }),
        network({ runtime: "other", gateway: "other-box-egress", envRoutes }),
      ],
    );

    expect(edits.spec.credentials).toEqual([
      { authorizerType: "ApiKeyCredentialProvider", name: "github" },
    ]);
    expect(edits.envLocal).toEqual([
      expect.objectContaining({ key: "AGENTCORE_CREDENTIAL_GITHUB", value: "ghp_1" }),
    ]);
  });

  test("runs before the gateway targets, so a target gets the credential it adds", () => {
    const models = [
      network({
        hosts: [host("api.github.com", "egress-github", { outboundAuth: GITHUB_AUTH })],
        envRoutes: [{ route: "github", variable: "GITHUB_TOKEN" }],
      }),
    ];

    const edits = run(BOX_NETWORK_WRITERS, models);

    expect(targetNames(edits.spec)).toEqual(["mine", "egress-github"]);
    expect(edits.spec.credentials.map(({ name }) => name)).toEqual(["github"]);
  });
});

describe("defaultTargetsWriter", () => {
  test("adds the Memory target and writes the role policy, as addBoxMemoryTarget does", () => {
    const project = spec();
    project.memories.push({
      name: "agentMemory",
      eventExpiryDuration: 30,
      strategies: [],
    } as never);

    const edits = run([defaultTargetsWriter], [network()], project);

    expect(targetNames(edits.spec)).toEqual(["mine", "agentcore"]);
    expect(edits.files.map(({ path }) => path)).toEqual([BOX_MEMORY_POLICY_FILE]);
  });

  test("adds no Memory target for an endpoint a target serves already", () => {
    const project = spec([{ ...getBoxGatewayAgentCoreTargetSpec(), name: "mem" }]);
    project.memories.push({
      name: "agentMemory",
      eventExpiryDuration: 30,
      strategies: [],
    } as never);

    const edits = run([defaultTargetsWriter], [network()], project);

    expect(targetNames(edits.spec)).toEqual(["mem"]);
    expect(edits.spec.agentCoreGateways[0]!.additionalPolicies).toEqual([BOX_MEMORY_POLICY_FILE]);
  });
});
