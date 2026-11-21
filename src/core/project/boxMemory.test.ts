import { describe, expect, test } from "bun:test";
import { getBoxGatewayBedrockTargetSpec } from "../../handlers/project/shortcuts";
import { boxGatewaySpec, type ProjectSpec } from "../../projectSchemas/project";
import {
  addBoxBedrockTarget,
  addBoxGatewayTargets,
  BOX_BEDROCK_POLICY_FILE,
  boxBedrockPolicy,
  LEGACY_BOX_MEMORY_POLICY_FILE,
  removeLegacyMemoryAccess,
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

describe("removeLegacyMemoryAccess", () => {
  /** The `agentcore` target, in `region`, as a build before Memory went direct wrote it. */
  const legacy = (region: string, dnsSuffix = "amazonaws.com") => ({
    name: "agentcore",
    targetType: "passthrough" as const,
    passthrough: {
      endpoint: `https://bedrock-agentcore.${region}.${dnsSuffix}`,
      protocolType: "CUSTOM" as const,
    },
    outboundAuth: {
      type: "GATEWAY_IAM_ROLE" as const,
      service: "bedrock-agentcore",
      region,
    },
  });

  test("removes the agentcore target of an earlier build, in any region, and the policy listing", () => {
    for (const [region, suffix] of [
      ["us-west-2", "amazonaws.com"],
      ["eu-central-1", "amazonaws.com"],
      ["cn-north-1", "amazonaws.com.cn"],
    ] as const) {
      const project = spec();
      gateway(project).targets = [getBoxGatewayBedrockTargetSpec(), legacy(region, suffix)];
      gateway(project).additionalPolicies = [
        BOX_BEDROCK_POLICY_FILE,
        LEGACY_BOX_MEMORY_POLICY_FILE,
      ];

      expect(removeLegacyMemoryAccess(project)).toEqual([
        `removing target 'agentcore' from gateway '${GATEWAY}' in agentcore.json: the boxed agent's Memory calls go to Memory directly`,
        `removing '${LEGACY_BOX_MEMORY_POLICY_FILE}' from gateway '${GATEWAY}' additionalPolicies in agentcore.json: its role no longer calls Memory`,
      ]);
      expect(targets(project)).toEqual(["bedrock"]);
      expect(gateway(project).additionalPolicies).toEqual([BOX_BEDROCK_POLICY_FILE]);
    }
  });

  test("drops additionalPolicies when the Memory file was its only entry", () => {
    const project = spec();
    gateway(project).additionalPolicies = [LEGACY_BOX_MEMORY_POLICY_FILE];

    removeLegacyMemoryAccess(project);

    expect(gateway(project).additionalPolicies).toBeUndefined();
  });

  test("keeps an agentcore target that the user changed, and one on a gateway that is not a Box gateway", () => {
    const project = spec();
    const changed = { ...legacy("us-west-2"), description: "mine" } as never;
    gateway(project).targets = [changed];
    const tools = {
      name: "tools",
      authorizerType: "AWS_IAM",
      targets: [legacy("us-west-2")],
    } as ProjectSpec["agentCoreGateways"][number];
    project.agentCoreGateways.push(tools);

    expect(removeLegacyMemoryAccess(project)).toEqual([]);
    expect(gateway(project).targets).toEqual([changed]);
    expect(tools.targets).toHaveLength(1);
  });

  test("runs first in addBoxGatewayTargets", () => {
    const project = spec();
    gateway(project).targets = [legacy("us-west-2")];

    expect(addBoxGatewayTargets(project, "us-west-2")[0]).toStartWith(
      "removing target 'agentcore'",
    );
    expect(targets(project)).toEqual(["bedrock"]);
  });
});
