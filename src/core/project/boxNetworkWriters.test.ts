import { describe, expect, test } from "bun:test";
import { getBoxGatewayAgentCoreTargetSpec } from "../../handlers/project/shortcuts";
import type { AgentCoreGatewayTarget } from "../../projectSchemas/gateway";
import { boxGatewaySpec, type ProjectSpec } from "../../projectSchemas/project";
import type { BoxNetwork, BoxNetworkHost } from "./boxNetwork";
import { BOX_BEDROCK_POLICY_FILE, BOX_MEMORY_POLICY_FILE } from "./boxMemory";
import {
  BOX_NETWORK_WRITERS,
  boxNetworkEdits,
  credentialsWriter,
  defaultTargetsWriter,
  gatewayTargetsWriter,
  runtimeProfileWriter,
  type BoxNetworkWriter,
} from "./boxNetworkWriters";
import { AGENTCORE_CODEZIP_PACK_PATH, AGENTCORE_PACK_PATH } from "./templates/boxProfile";

/** A hand-built model of runtime `agent`, which each test changes as it needs. */
function network(overrides: Partial<BoxNetwork> = {}): BoxNetwork {
  return {
    runtime: "agent",
    gateway: "agent-box-egress",
    region: "us-west-2",
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
    expect(targetNames(edits.spec)).toEqual(["mine", "egress-api", "bedrock"]);
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

    expect(targetNames(edits.spec)).toEqual(["mine", "egress-github", "bedrock"]);
    expect(edits.spec.credentials.map(({ name }) => name)).toEqual(["github"]);
  });
});

describe("defaultTargetsWriter", () => {
  test("adds the model and Memory targets and writes the role policies, as addBoxGatewayTargets does", () => {
    const project = spec();
    project.memories.push({
      name: "agentMemory",
      eventExpiryDuration: 30,
      strategies: [],
    } as never);

    const edits = run([defaultTargetsWriter], [network()], project);

    expect(targetNames(edits.spec)).toEqual(["mine", "bedrock", "agentcore"]);
    expect(edits.files.map(({ path }) => path)).toEqual([
      BOX_BEDROCK_POLICY_FILE,
      BOX_MEMORY_POLICY_FILE,
    ]);
  });

  test("writes the model and Memory targets for the region of the build", () => {
    const project = spec();
    project.memories.push({
      name: "agentMemory",
      eventExpiryDuration: 30,
      strategies: [],
    } as never);

    const edits = run([defaultTargetsWriter], [network({ region: "eu-central-1" })], project);

    const regions = edits.spec.agentCoreGateways[0]!.targets.map(
      ({ name, outboundAuth }) => `${name}:${outboundAuth?.region}`,
    );
    expect(regions).toEqual(["mine:undefined", "bedrock:eu-central-1", "agentcore:eu-central-1"]);
  });

  test("adds no default target for an endpoint a target serves already", () => {
    const project = spec([
      { ...getBoxGatewayAgentCoreTargetSpec(), name: "mem" },
      passthrough("egress-models", "https://bedrock-runtime.us-west-2.amazonaws.com"),
    ]);
    project.memories.push({
      name: "agentMemory",
      eventExpiryDuration: 30,
      strategies: [],
    } as never);

    const edits = run([defaultTargetsWriter], [network()], project);

    expect(targetNames(edits.spec)).toEqual(["mem", "egress-models"]);
    expect(edits.spec.agentCoreGateways[0]!.additionalPolicies).toEqual([
      BOX_BEDROCK_POLICY_FILE,
      BOX_MEMORY_POLICY_FILE,
    ]);
  });
});

describe("runtimeProfileWriter", () => {
  test("writes the Runtime profile and a byte copy of each policy file beside it", () => {
    const writer = runtimeProfileWriter([
      { runtime: "agent", dist: "app/agent/.box-dist", kind: "codezip" },
    ]);
    const models = [network({ policyFiles: ["policy.dw", "rules/extra.dw"] })];

    const { files } = run([writer], models);

    expect(writer.writes(models)).toEqual([
      { kind: "file", path: "app/agent/.box-dist/profile.toml" },
      { kind: "file", path: `app/agent/.box-dist/${AGENTCORE_PACK_PATH}` },
      { kind: "file", path: `app/agent/.box-dist/${AGENTCORE_CODEZIP_PACK_PATH}` },
      { kind: "file", path: "app/agent/.box-dist/policy.dw" },
      { kind: "file", path: "app/agent/.box-dist/rules/extra.dw" },
    ]);
    // The writer writes exactly the files it declares.
    expect(files.map(({ path }) => ({ kind: "file", path })) as unknown).toEqual(
      writer.writes(models),
    );
    expect(files.slice(3)).toEqual([
      { path: "app/agent/.box-dist/policy.dw", copyOf: ".box/policy.dw" },
      { path: "app/agent/.box-dist/rules/extra.dw", copyOf: ".box/rules/extra.dw" },
    ]);
    expect("text" in files[0]! && files[0].text).toContain(
      'policies = ["policy.dw", "rules/extra.dw"]',
    );
  });

  test("stages only the box/agentcore pack for a container", () => {
    const writer = runtimeProfileWriter([
      { runtime: "agent", dist: "app/agent/.box-dist", kind: "container" },
    ]);

    expect(writer.writes([network()])).toEqual([
      { kind: "file", path: "app/agent/.box-dist/profile.toml" },
      { kind: "file", path: `app/agent/.box-dist/${AGENTCORE_PACK_PATH}` },
    ]);
  });
});
