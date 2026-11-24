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
  const ACTIONS = ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"];
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
  const statements = (project: ProjectSpec) =>
    (boxBedrockPolicy(project, "us-west-2") as { Statement: Statement[] }).Statement;

  test("allows only the runtime's inference profile, and its model only through that profile", () => {
    const profile =
      "arn:aws:bedrock:us-west-2:${aws:PrincipalAccount}:inference-profile/global.anthropic.claude-sonnet-5-5";
    expect(
      statements(
        withModels({ modelProvider: "Bedrock", modelId: "global.anthropic.claude-sonnet-5-5" }),
      ),
    ).toEqual([
      {
        Sid: "BoxedAgentInferenceProfileThroughGateway",
        Effect: "Allow",
        Action: ACTIONS,
        Resource: [
          "arn:aws:bedrock:us-west-2:*:inference-profile/global.anthropic.claude-sonnet-5-5",
        ],
        Condition: { StringEquals: { "aws:ResourceAccount": "${aws:PrincipalAccount}" } },
      },
      {
        Sid: "BoxedAgentModelThroughItsInferenceProfile",
        Effect: "Allow",
        Action: ACTIONS,
        Resource: ["arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5-5*"],
        Condition: { StringEquals: { "bedrock:InferenceProfileArn": profile } },
      },
    ]);
  });

  test("allows a model ID only as that foundation model in the region", () => {
    expect(
      statements(withModels({ modelProvider: "Bedrock", modelId: "amazon.nova-pro-v1:0" })),
    ).toEqual([
      {
        Sid: "BoxedAgentModelThroughGateway",
        Effect: "Allow",
        Action: ACTIONS,
        Resource: ["arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-pro-v1:0"],
      },
    ]);
  });

  test("allows the model of each runtime once, each statement with its own Sid", () => {
    const policy = statements(
      withModels(
        { modelProvider: "Bedrock", modelId: "us.anthropic.claude-sonnet-5-5" },
        { modelProvider: "Bedrock", modelId: "us.anthropic.claude-sonnet-5-5" },
        { modelProvider: "LiteLLM", modelId: "bedrock/amazon.nova-pro-v1:0" },
      ),
    );
    expect(policy.map(({ Sid }) => Sid)).toEqual([
      "BoxedAgentInferenceProfileThroughGateway1",
      "BoxedAgentModelThroughItsInferenceProfile1",
      "BoxedAgentModelThroughGateway2",
    ]);
  });

  test("keeps every model, and warns, when a runtime that calls a model has no modelId", () => {
    const project = withModels(
      { modelProvider: "Bedrock", modelId: "global.anthropic.claude-sonnet-5-5" },
      { modelProvider: "Bedrock" },
    );
    expect(statements(project).map(({ Sid }) => Sid)).toEqual([
      "BoxedAgentInferenceProfilesThroughGateway",
      "BoxedAgentModelsInRegionThroughGateway",
      "BoxedAgentModelsThroughInferenceProfiles",
    ]);
    expect(boxBedrockScopeWarning(project)).toContain('runtime "agent1" has no modelId');
  });

  test("gives no warning for a runtime with no model provider, which calls no model as created", () => {
    expect(boxBedrockScopeWarning(withModels({}))).toBeUndefined();
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
