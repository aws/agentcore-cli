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
  telemetryPolicyWriter,
  type BoxNetworkWriter,
} from "./boxNetworkWriters";
import { AGENTCORE_CODEZIP_PACK_PATH, AGENTCORE_PACK_PATH } from "./templates/boxProfile";
import { serializeRuntimeProfile } from "./runtimeProfile/serialize";

/** A hand-built model of runtime `agent`, which each test changes as it needs. */
function network(overrides: Partial<BoxNetwork> = {}): BoxNetwork {
  return {
    runtime: "agent",
    gateway: "agent-box-egress",
    region: "us-west-2",
    hosts: [],
    envRoutes: [],
    policyFiles: [],
    runtimeProfile: { packs: ["@box/base", "@box/agentcore"], profile: { name: "demo" } },
    runtimeProfileHeader: ["Derived from .box/agent/local/profile.toml."],
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
      {
        name: "agent",
        build: "CodeZip",
        entrypoint: "start.py",
        codeLocation: "app/agent",
        box: { version: "1.0.0" },
      },
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

/** What each writer reads besides the models, for `project`. */
const contextFor = (project = spec()) => ({
  spec: project,
  projectRoot: "/nonexistent/project",
  env: { GITHUB_TOKEN: "ghp_1" },
  envLocal: {},
});

const run = (writers: readonly BoxNetworkWriter[], networks: BoxNetwork[], project = spec()) =>
  boxNetworkEdits(writers, networks, contextFor(project));

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

  test("writes the Memory policy for the region of the agentcore target it writes", () => {
    const project = spec();
    project.memories.push({
      name: "agentMemory",
      eventExpiryDuration: 30,
      strategies: [],
    } as never);

    const edits = run([defaultTargetsWriter], [network({ region: "eu-central-1" })], project);

    const agentcore = edits.spec.agentCoreGateways[0]!.targets.find(
      ({ name }) => name === "agentcore",
    );
    expect(agentcore?.outboundAuth?.region).toBe("eu-central-1");
    const memory = edits.files.find(({ path }) => path === BOX_MEMORY_POLICY_FILE);
    expect(JSON.parse((memory as { text: string }).text).Statement).toEqual([
      expect.objectContaining({
        Resource: ["arn:aws:bedrock-agentcore:eu-central-1:*:memory/demo_*agentMemory-*"],
        Condition: { StringEquals: { "aws:ResourceAccount": "${aws:PrincipalAccount}" } },
      }),
    ]);
  });

  test("writes the Bedrock policy for the region of the bedrock target it writes", () => {
    const edits = run([defaultTargetsWriter], [network({ region: "eu-central-1" })]);

    const bedrock = edits.spec.agentCoreGateways[0]!.targets.find(({ name }) => name === "bedrock");
    expect(bedrock?.outboundAuth?.region).toBe("eu-central-1");
    const policy = edits.files.find(({ path }) => path === BOX_BEDROCK_POLICY_FILE);
    const resources = JSON.parse((policy as { text: string }).text).Statement.map(
      ({ Resource }: { Resource: string[] }) => Resource,
    );
    expect(resources).toEqual([
      ["arn:aws:bedrock:eu-central-1:*:inference-profile/*"],
      ["arn:aws:bedrock:eu-central-1::foundation-model/*"],
      ["arn:aws:bedrock:*::foundation-model/*"],
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

describe("telemetryPolicyWriter", () => {
  const logs = (logGroup: string) =>
    ({
      name: "logs",
      kind: "cloudwatch_logs",
      region: "us-west-2",
      logGroup,
      logStream: "s",
    }) as const;
  const statementOf = (text: string) =>
    (JSON.parse(text) as { Statement: { Resource: unknown }[] }).Statement.map(
      ({ Resource }) => Resource,
    );

  test("writes for each box runtime the grant of its own telemetry, and none for one with none", () => {
    const project = spec();
    const runtime = (name: string, rest: Record<string, unknown> = {}) =>
      ({
        ...project.runtimes[0]!,
        name,
        codeLocation: `app/${name}`,
        ...rest,
      }) as ProjectSpec["runtimes"][number];
    project.runtimes.push(
      runtime("second"),
      runtime("quiet", { additionalPolicies: ["../../agentcore/box-telemetry-policy-quiet.json"] }),
    );
    const models = [
      network({ telemetry: [logs("group-a")] }),
      network({ runtime: "second", gateway: "second-box-egress", telemetry: [logs("group-b")] }),
      network({ runtime: "quiet", gateway: "quiet-box-egress" }),
    ];

    const edits = run([telemetryPolicyWriter], models, project);

    expect(telemetryPolicyWriter.writes(models, contextFor(project))).toEqual([
      { kind: "runtimePolicies" },
      { kind: "file", path: "agentcore/box-telemetry-policy-agent.json" },
      { kind: "file", path: "agentcore/box-telemetry-policy-second.json" },
      { kind: "file", path: "agentcore/box-telemetry-policy-quiet.json" },
    ]);
    const [agent, second, quiet] = edits.files;
    expect(agent?.path).toBe("agentcore/box-telemetry-policy-agent.json");
    expect(statementOf("text" in agent! ? agent.text : "")).toEqual([
      ["arn:aws:logs:us-west-2:*:log-group:group-a:log-stream:s"],
    ]);
    expect(second?.path).toBe("agentcore/box-telemetry-policy-second.json");
    expect(statementOf("text" in second! ? second.text : "")).toEqual([
      ["arn:aws:logs:us-west-2:*:log-group:group-b:log-stream:s"],
    ]);
    expect(quiet).toEqual({ path: "agentcore/box-telemetry-policy-quiet.json", remove: true });
    expect(edits.spec.runtimes.map(({ additionalPolicies }) => additionalPolicies)).toEqual([
      ["../../agentcore/box-telemetry-policy-agent.json"],
      ["../../agentcore/box-telemetry-policy-second.json"],
      undefined,
    ]);
    expect(edits.changedFields).toEqual(["runtimes"]);
    expect(edits.messages).toEqual([
      "adding agentcore/box-telemetry-policy-agent.json to additionalPolicies of 'agent', so its " +
        "box can send telemetry to CloudWatch",
      "adding agentcore/box-telemetry-policy-second.json to additionalPolicies of 'second', so " +
        "its box can send telemetry to CloudWatch",
      "removing agentcore/box-telemetry-policy-quiet.json from additionalPolicies of 'quiet': its " +
        "box sends no telemetry to CloudWatch",
    ]);
  });

  test("declares the policy file of every runtime, also one with no box, which it removes", () => {
    const project = spec();
    project.runtimes.push({
      ...project.runtimes[0]!,
      name: "plain",
      codeLocation: "app/plain",
    } as ProjectSpec["runtimes"][number]);
    const models = [network({ telemetry: [logs("group-a")] })];
    const plain = { kind: "file", path: "agentcore/box-telemetry-policy-plain.json" } as const;

    expect(telemetryPolicyWriter.writes(models, contextFor(project))).toEqual([
      { kind: "runtimePolicies" },
      { kind: "file", path: "agentcore/box-telemetry-policy-agent.json" },
      plain,
    ]);
    expect(run([telemetryPolicyWriter], models, project).files.at(-1)).toEqual({
      path: plain.path,
      remove: true,
    });
    const other: BoxNetworkWriter = { name: "other", writes: () => [plain], edits: () => ({}) };
    expect(() => run([telemetryPolicyWriter, other], models, project)).toThrow(
      `Box network writers 'telemetry policy' and 'other' both write ${JSON.stringify(plain)}`,
    );
  });
});

describe("runtimeProfileWriter", () => {
  test("writes the Runtime profile and a byte copy of each policy file beside it", () => {
    const writer = runtimeProfileWriter([
      { runtime: "agent", dist: "app/agent/.box-dist", kind: "codezip" },
    ]);
    const policies = ["policy.dw", "rules/extra.dw"];
    const runtimeProfile = { packs: ["@box/base", "@box/agentcore"], policies };
    const models = [network({ policyFiles: policies, runtimeProfile })];

    const { files } = run([writer], models);

    expect(writer.writes(models, contextFor())).toEqual([
      { kind: "file", path: "app/agent/.box-dist/profile.toml" },
      { kind: "file", path: `app/agent/.box-dist/${AGENTCORE_PACK_PATH}` },
      { kind: "file", path: `app/agent/.box-dist/${AGENTCORE_CODEZIP_PACK_PATH}` },
      { kind: "file", path: "app/agent/.box-dist/policy.dw" },
      { kind: "file", path: "app/agent/.box-dist/rules/extra.dw" },
    ]);
    // The writer writes exactly the files it declares.
    expect(files.map(({ path }) => ({ kind: "file", path })) as unknown).toEqual(
      writer.writes(models, contextFor()),
    );
    expect(files.slice(3)).toEqual([
      { path: "app/agent/.box-dist/policy.dw", copyOf: ".box/agent/local/policy.dw" },
      { path: "app/agent/.box-dist/rules/extra.dw", copyOf: ".box/agent/local/rules/extra.dw" },
    ]);
    // The profile is the one build derived from the local profile, after its header.
    expect("text" in files[0]! && files[0].text).toBe(
      serializeRuntimeProfile(runtimeProfile, ["Derived from .box/agent/local/profile.toml."]),
    );
  });

  test("stops for a runtime that it stages with no derived Runtime profile", () => {
    const writer = runtimeProfileWriter([
      { runtime: "agent", dist: ".box/agent/aws", kind: "codezip" },
    ]);

    expect(() => run([writer], [])).toThrow(
      'runtime "agent" runs its agent in a box, but build has no AgentCore Runtime profile for it',
    );
  });

  test("stages only the @box/agentcore pack for a container", () => {
    const writer = runtimeProfileWriter([
      { runtime: "agent", dist: "app/agent/.box-dist", kind: "container" },
    ]);

    expect(writer.writes([network()], contextFor())).toEqual([
      { kind: "file", path: "app/agent/.box-dist/profile.toml" },
      { kind: "file", path: `app/agent/.box-dist/${AGENTCORE_PACK_PATH}` },
    ]);
  });
});
