import { describe, expect, test } from "bun:test";
import { getBoxGatewayBedrockEntry } from "../../handlers/project/box-gateway-test-support";
import type { AgentCoreGatewayTarget } from "../../projectSchemas/gateway";
import type { ProjectSpec } from "../../projectSchemas/project";
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

/** A hand-built model of runtime `agent`, which each test changes as it needs. */
function network(overrides: Partial<BoxNetwork> = {}): BoxNetwork {
  return {
    runtime: "agent",
    gateway: "agent-box",
    region: "us-west-2",
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
      "updating gateway target 'egress-github' of 'agent-box' for api.github.com",
      "removing gateway target 'egress-old' from 'agent-box': the Box profile no longer allows old.example.com",
      "adding gateway target 'egress-httpbin-org' to 'agent-box' for httpbin.org",
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
      "updating gateway target 'egress-github' of 'agent-box' for api.github.com",
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
  test("adds the Memory target and writes the role policies, as addBoxGatewayTargets does", () => {
    const project = spec();
    project.memories.push({
      name: "agentMemory",
      eventExpiryDuration: 30,
      strategies: [],
    } as never);

    const edits = run([defaultTargetsWriter], [network()], project);

    expect(targetNames(edits.spec)).toEqual(["bedrock", "agentcore"]);
    expect(edits.files.map(({ path }) => path)).toEqual([
      BOX_BEDROCK_POLICY_FILE,
      BOX_MEMORY_POLICY_FILE,
    ]);
  });

  test("adds no default target for an endpoint a target serves already", () => {
    const project = spec([
      passthrough("egress-models", "https://bedrock-runtime.us-west-2.amazonaws.com"),
    ]);

    const edits = run([defaultTargetsWriter], [network()], project);

    expect(targetNames(edits.spec)).toEqual(["egress-models"]);
    expect(edits.spec.agentCoreGateways[0]!.additionalPolicies).toEqual([BOX_BEDROCK_POLICY_FILE]);
  });

  test("runs after the egress targets, so a new egress- target is not doubled", () => {
    const models = [network({ hosts: [host("api.example.com", "egress-api")] })];

    expect(targetNames(run(BOX_NETWORK_WRITERS, models).spec)).toEqual(["bedrock", "egress-api"]);
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
      network({ runtime: "second", gateway: "second-box", telemetry: [logs("group-b")] }),
      network({ runtime: "quiet", gateway: "quiet-box" }),
    ];

    const edits = run([telemetryPolicyWriter], models, project);

    expect(telemetryPolicyWriter.writes(models)).toEqual([
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
    expect(edits.messages).toEqual([
      "adding agentcore/box-telemetry-policy-agent.json to additionalPolicies of 'agent', so its " +
        "box can send telemetry to CloudWatch",
      "adding agentcore/box-telemetry-policy-second.json to additionalPolicies of 'second', so " +
        "its box can send telemetry to CloudWatch",
      "removing agentcore/box-telemetry-policy-quiet.json from additionalPolicies of 'quiet': its " +
        "box sends no telemetry to CloudWatch",
    ]);
  });
});

describe("the secrets of third-party telemetry targets", () => {
  const langsmith = {
    name: "langsmith",
    kind: "langsmith",
    keys: [],
    secret: { variable: "LANGSMITH_KEY", keys: [] },
  } as const;
  const logs = {
    name: "logs",
    kind: "cloudwatch_logs",
    region: "us-west-2",
    logGroup: "g",
    logStream: "s",
  } as const;
  const SECRET_ARN = "arn:aws:secretsmanager:us-west-2:*:secret:agentcore/demo/agent/box-??????";

  test("adds the read of each secret to the runtime's telemetry policy, after its CloudWatch grant", () => {
    const edits = run(
      [telemetryPolicyWriter],
      [network({ telemetry: [logs], thirdPartyTelemetry: [langsmith] })],
    );

    const [file] = edits.files;
    expect(JSON.parse("text" in file! ? file.text : "")).toEqual({
      Version: "2012-10-17",
      Statement: [
        expect.objectContaining({ Sid: "BoxTelemetryToCloudWatchLogs" }),
        {
          Sid: "BoxTelemetrySecrets",
          Effect: "Allow",
          Action: ["secretsmanager:GetSecretValue"],
          Resource: [SECRET_ARN],
        },
      ],
    });
    expect(edits.spec.runtimes[0]!.additionalPolicies).toEqual([
      "../../agentcore/box-telemetry-policy-agent.json",
    ]);
  });

  test("writes the policy for a runtime whose only grant is the read of a secret", () => {
    const edits = run([telemetryPolicyWriter], [network({ thirdPartyTelemetry: [langsmith] })]);

    const [file] = edits.files;
    expect(JSON.parse("text" in file! ? file.text : "").Statement).toEqual([
      expect.objectContaining({ Sid: "BoxTelemetrySecrets", Resource: [SECRET_ARN] }),
    ]);
  });

  test("grants no read for a target with no key", () => {
    const open = { name: "open", kind: "otlp", keys: [["destination", "https://o.example"]] };

    const edits = run([telemetryPolicyWriter], [network({ thirdPartyTelemetry: [open as never] })]);

    expect(edits.files).toEqual([
      { path: "agentcore/box-telemetry-policy-agent.json", remove: true },
    ]);
  });

  test("copies each key the box profile's variable holds to .env.local for deploy", () => {
    const edits = boxNetworkEdits(
      [credentialsWriter],
      [network({ thirdPartyTelemetry: [langsmith] })],
      {
        spec: spec(),
        projectRoot: "/nonexistent/project",
        env: { LANGSMITH_KEY: "dummy-key" },
      },
    );

    expect(edits.envLocal).toEqual([
      expect.objectContaining({
        key: "AGENTCORE_CREDENTIAL_AGENT_TELEMETRY_LANGSMITH",
        value: "dummy-key",
      }),
    ]);
    // The target needs a secret, not a credential provider.
    expect(edits.spec.credentials).toEqual([]);
  });
});

describe("runtimeProfileWriter", () => {
  test("writes the Runtime profile and a byte copy of each policy file beside it", () => {
    const writer = runtimeProfileWriter([
      { runtime: "agent", dist: "app/agent/.box-dist", container: false, codezip: false },
    ]);
    const models = [network({ policyFiles: ["policy.dw", "rules/extra.dw"] })];

    const { files } = run([writer], models);

    expect(writer.writes(models)).toEqual([
      { kind: "file", path: "app/agent/.box-dist/profile.toml" },
      { kind: "file", path: "app/agent/.box-dist/policy.dw" },
      { kind: "file", path: "app/agent/.box-dist/rules/extra.dw" },
    ]);
    expect(files.slice(1)).toEqual([
      { path: "app/agent/.box-dist/policy.dw", copyOf: ".box/agent/local/policy.dw" },
      { path: "app/agent/.box-dist/rules/extra.dw", copyOf: ".box/agent/local/rules/extra.dw" },
    ]);
    expect("text" in files[0]! && files[0].text).toContain(
      'policies = ["policy.dw", "rules/extra.dw"]',
    );
  });
});
