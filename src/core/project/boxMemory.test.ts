import { describe, expect, test } from "bun:test";
import { getBoxGatewayBedrockTargetSpec } from "../../handlers/project/shortcuts";
import { boxGatewaySpec, type ProjectSpec } from "../../projectSchemas/project";
import {
  addBoxBedrockTarget,
  addBoxGatewayTargets,
  BOX_BEDROCK_POLICY_FILE,
  boxBedrockPolicy,
  boxBedrockScopeWarning,
} from "./boxMemory";

function spec(options: { entrypoint?: string; memories?: string[] } = {}): ProjectSpec {
  return {
    name: "demo",
    projectType: "box",
    runtimes: [
      {
        name: "agent",
        build: "CodeZip",
        entrypoint: options.entrypoint ?? "start.py",
        codeLocation: "app/agent",
        // create writes box.version only for a box template, whose entry point is start.py.
        ...(options.entrypoint === undefined && { box: { version: "1.0.0" } }),
      },
    ],
    memories: (options.memories ?? ["agentMemory"]).map((name) => ({
      name,
      eventExpiryDuration: 30,
      strategies: [],
    })),
    agentCoreGateways: [boxGatewaySpec("agent")],
  } as unknown as ProjectSpec;
}

const GATEWAY = "agent-box-egress";

const gateway = (project: ProjectSpec) =>
  project.agentCoreGateways.find(({ name }) => name === GATEWAY)!;

const targets = (project: ProjectSpec) => gateway(project).targets.map(({ name }) => name);

describe("addBoxBedrockTarget", () => {
  test("adds the bedrock target and its policy for a boxed agent that calls Bedrock", () => {
    const project = spec({ memories: [] });

    expect(addBoxBedrockTarget(project)).toEqual([
      `adding target 'bedrock' to gateway '${GATEWAY}' in agentcore.json, for the boxed agent's model calls`,
      `adding 'agentcore/box-bedrock-policy.json' to gateway '${GATEWAY}' additionalPolicies in agentcore.json, so its role can call the Bedrock model`,
    ]);
    expect(gateway(project).targets).toEqual([getBoxGatewayBedrockTargetSpec()]);
    expect(gateway(project).additionalPolicies).toEqual([BOX_BEDROCK_POLICY_FILE]);
    expect(addBoxBedrockTarget(project)).toEqual([]);
  });

  test("adds nothing for an MCP server, an agent on another provider, or outside a Box project", () => {
    const mcp = spec({ memories: [] });
    mcp.runtimes[0]!.protocol = "MCP";
    const openai = spec({ memories: [] });
    openai.runtimes[0]!.modelProvider = "OpenAI";
    const { projectType: _omitted, ...rest } = spec({ memories: [] });
    const plain = rest as ProjectSpec;

    for (const project of [mcp, openai, plain]) {
      expect(addBoxBedrockTarget(project)).toEqual([]);
      expect(boxBedrockPolicy(project, "us-west-2")).toBeUndefined();
    }
  });

  test("leaves a gateway that imports its role without the policy", () => {
    const project = spec({ memories: [] });
    gateway(project).executionRoleArn = "arn:aws:iam::123456789012:role/mine";

    addBoxBedrockTarget(project);

    expect(targets(project)).toEqual(["bedrock"]);
    expect(gateway(project).additionalPolicies).toBeUndefined();
  });
});

describe("boxBedrockPolicy", () => {
  type Statement = Record<string, unknown> & { Resource: string[] };
  const statements = (region: string) =>
    (boxBedrockPolicy(spec(), region) as { Statement: Statement[] }).Statement;
  const ACTIONS = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"];

  test("allows the inference profiles of the gateway role's account in the region it is given, and no other", () => {
    expect(statements("eu-central-1")).toHaveLength(3);
    expect(statements("eu-central-1")[0]).toEqual({
      Sid: "BoxedAgentInferenceProfilesThroughGateway",
      Effect: "Allow",
      Action: ACTIONS,
      Resource: ["arn:aws:bedrock:eu-central-1:*:inference-profile/*"],
      Condition: { StringEquals: { "aws:ResourceAccount": "${aws:PrincipalAccount}" } },
    });
  });

  test("allows a foundation model by its own ID only in the region it is given", () => {
    expect(statements("eu-central-1")[1]).toEqual({
      Sid: "BoxedAgentModelsInRegionThroughGateway",
      Effect: "Allow",
      Action: ACTIONS,
      Resource: ["arn:aws:bedrock:eu-central-1::foundation-model/*"],
    });
  });

  test("allows a foundation model in another region only through an inference profile of that account and region", () => {
    expect(statements("eu-central-1")[2]).toEqual({
      Sid: "BoxedAgentModelsThroughInferenceProfiles",
      Effect: "Allow",
      Action: ACTIONS,
      Resource: ["arn:aws:bedrock:*::foundation-model/*"],
      Condition: {
        StringLike: {
          "bedrock:InferenceProfileArn":
            "arn:aws:bedrock:eu-central-1:${aws:PrincipalAccount}:inference-profile/*",
        },
      },
    });
  });

  test("names the partition of the region it is given", () => {
    const [profiles, inRegion, throughProfiles] = statements("cn-north-1");

    expect(profiles!.Resource).toEqual(["arn:aws-cn:bedrock:cn-north-1:*:inference-profile/*"]);
    expect(inRegion!.Resource).toEqual(["arn:aws-cn:bedrock:cn-north-1::foundation-model/*"]);
    expect(throughProfiles!.Resource).toEqual(["arn:aws-cn:bedrock:*::foundation-model/*"]);
    expect(throughProfiles!.Condition).toEqual({
      StringLike: {
        "bedrock:InferenceProfileArn":
          "arn:aws-cn:bedrock:cn-north-1:${aws:PrincipalAccount}:inference-profile/*",
      },
    });
    expect(statements("us-gov-west-1")[1]!.Resource).toEqual([
      "arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/*",
    ]);
  });
});

describe("boxBedrockPolicy with the runtime's modelId", () => {
  type Statement = Record<string, unknown> & { Resource: string[] };
  const withModels = (...models: { modelProvider?: string; modelId?: string }[]) => {
    const project = spec();
    const [first] = project.runtimes;
    project.runtimes = models.map((model, index) => ({
      ...first!,
      name: `agent${index}`,
      ...model,
    })) as ProjectSpec["runtimes"];
    return project;
  };
  const policy = (project: ProjectSpec) =>
    (boxBedrockPolicy(project, "us-west-2") as { Statement: Statement[] }).Statement;
  const resources = (project: ProjectSpec) => policy(project).map(({ Resource }) => Resource[0]);
  const bedrock = (modelId: string) => withModels({ modelProvider: "Bedrock", modelId });
  const EVERY_MODEL = [
    "arn:aws:bedrock:us-west-2:*:inference-profile/*",
    "arn:aws:bedrock:us-west-2::foundation-model/*",
    "arn:aws:bedrock:*::foundation-model/*",
  ];

  test("allows a system inference profile of the account, and its model only through that profile", () => {
    const statements = policy(bedrock("global.anthropic.claude-sonnet-5-5"));
    expect(statements.map(({ Resource }) => Resource[0])).toEqual([
      "arn:aws:bedrock:us-west-2:*:inference-profile/global.anthropic.claude-sonnet-5-5",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5-5*",
      "arn:aws:bedrock:us-west-2::foundation-model/global.anthropic.claude-sonnet-5-5",
    ]);
    expect(statements[0]!.Condition).toEqual({
      StringEquals: { "aws:ResourceAccount": "${aws:PrincipalAccount}" },
    });
    expect(statements[1]!.Condition).toEqual({
      StringEquals: {
        "bedrock:InferenceProfileArn":
          "arn:aws:bedrock:us-west-2:${aws:PrincipalAccount}:inference-profile/global.anthropic.claude-sonnet-5-5",
      },
    });
    expect(statements[2]!.Condition).toBeUndefined();
  });

  test("needs no list of geographic prefixes: an in. profile scopes like any other", () => {
    expect(resources(bedrock("in.anthropic.claude-sonnet-5"))).toContain(
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5*",
    );
  });

  test("allows a plain model ID as that foundation model in the region", () => {
    expect(resources(bedrock("amazon.nova-pro-v1:0"))).toContain(
      "arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-pro-v1:0",
    );
  });

  test("allows a system inference profile ARN in its own region, and no model by itself", () => {
    expect(
      resources(
        bedrock(
          "arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-sonnet-5-5",
        ),
      ),
    ).toEqual([
      "arn:aws:bedrock:eu-west-1:*:inference-profile/eu.anthropic.claude-sonnet-5-5",
      "arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5-5*",
    ]);
  });

  test("allows a foundation model ARN as that model in its own region only", () => {
    expect(
      resources(bedrock("arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0")),
    ).toEqual(["arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0"]);
  });

  test.each([
    "bedrock/us.anthropic.claude-sonnet-5-5",
    "bedrock/converse/us.anthropic.claude-sonnet-5-5",
    "bedrock/invoke/us.anthropic.claude-sonnet-5-5",
  ])("scopes LiteLLM's Bedrock route %s to the model after it", (modelId) => {
    expect(resources(withModels({ modelProvider: "LiteLLM", modelId }))[0]).toBe(
      "arn:aws:bedrock:us-west-2:*:inference-profile/us.anthropic.claude-sonnet-5-5",
    );
  });

  test.each([
    [
      "an application inference profile ARN",
      "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/abc123",
    ],
    ["a provisioned model ARN", "arn:aws:bedrock:us-west-2:123456789012:provisioned-model/abc123"],
    ["an ID that is not provider.model", "my-model"],
  ])("keeps every model, and warns, for %s", (_kind, modelId) => {
    const project = bedrock(modelId);
    expect(resources(project)).toEqual(EVERY_MODEL);
    expect(boxBedrockScopeWarning(project)).toContain('runtime "agent0" has no modelId');
  });

  test("allows the model of each runtime once, each statement with its own Sid", () => {
    const statements = policy(
      withModels(
        { modelProvider: "Bedrock", modelId: "us.anthropic.claude-sonnet-5-5" },
        { modelProvider: "Bedrock", modelId: "us.anthropic.claude-sonnet-5-5" },
        { modelProvider: "LiteLLM", modelId: "bedrock/amazon.nova-pro-v1:0" },
      ),
    );
    const sids = statements.map(({ Sid }) => Sid);
    expect(new Set(sids).size).toBe(sids.length);
    expect(statements.filter(({ Sid }) => String(Sid).endsWith("1"))).toHaveLength(3);
    expect(statements.filter(({ Sid }) => String(Sid).endsWith("2"))).toHaveLength(3);
  });

  test("keeps every model, and warns, when a runtime with no model provider calls Bedrock with no modelId", () => {
    // A minimal-box or an added runtime has no modelProvider, and build counts it as calling Bedrock.
    const project = withModels(
      { modelProvider: "Bedrock", modelId: "global.anthropic.claude-sonnet-5-5" },
      {},
    );
    expect(resources(project)).toEqual(EVERY_MODEL);
    expect(boxBedrockScopeWarning(project)).toContain('runtime "agent1" has no modelId');
  });

  test("names each unscoped runtime in one sentence", () => {
    expect(boxBedrockScopeWarning(withModels({}, {}, {}))).toContain(
      'runtimes "agent0", "agent1" and "agent2" have no modelId',
    );
  });

  test("gives no warning when the policy is scoped", () => {
    expect(boxBedrockScopeWarning(bedrock("global.anthropic.claude-sonnet-5-5"))).toBeUndefined();
  });
});

describe("addBoxGatewayTargets", () => {
  test("adds the bedrock target a boxed agent's model calls take, in the region given", () => {
    const project = spec();

    addBoxGatewayTargets(project, "eu-central-1");

    expect(gateway(project).targets).toEqual([getBoxGatewayBedrockTargetSpec("eu-central-1")]);
  });

  test("adds no target and no policy for the default Memory: its calls go to Memory directly", () => {
    const project = spec();
    project.runtimes[0]!.modelProvider = "OpenAI";

    expect(addBoxGatewayTargets(project)).toEqual([]);
    expect(targets(project)).toEqual([]);
    expect(gateway(project).additionalPolicies).toBeUndefined();
  });

  test("moves a target it wrote for another region, and keeps one the user changed", () => {
    const project = spec();
    addBoxGatewayTargets(project, "us-west-2");

    expect(addBoxGatewayTargets(project, "us-east-1")).toEqual([
      `updating target 'bedrock' of gateway '${GATEWAY}' in agentcore.json from us-west-2 to us-east-1`,
    ]);
    expect(gateway(project).targets).toEqual([getBoxGatewayBedrockTargetSpec("us-east-1")]);

    const bedrock = gateway(project).targets[0]!;
    // The user signs for another service, so the target is no longer the one build wrote.
    gateway(project).targets[0] = {
      ...bedrock,
      outboundAuth: { ...bedrock.outboundAuth!, service: "bedrock-runtime" },
    };
    expect(addBoxGatewayTargets(project, "eu-west-1")).toEqual([]);
    expect(gateway(project).targets[0]!.outboundAuth?.region).toBe("us-east-1");
  });
});
