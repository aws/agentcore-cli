import { describe, expect, test } from "bun:test";
import { InputValidationError } from "../../errors/errors";
import {
  getBoxGatewayAgentCoreTargetSpec,
  getBoxGatewayBedrockTargetSpec,
} from "../../handlers/project/shortcuts";
import { boxGatewaySpec, type ProjectSpec } from "../../projectSchemas/project";
import {
  addBoxBedrockTarget,
  addBoxGatewayTargets,
  addBoxMemoryTarget,
  BOX_BEDROCK_POLICY_FILE,
  BOX_MEMORY_POLICY_FILE,
  boxBedrockPolicy,
  boxMemoryPolicy,
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

describe("addBoxMemoryTarget", () => {
  test("adds the agentcore target to the runtime's Box gateway for its default Memory", () => {
    const project = spec();

    expect(addBoxMemoryTarget(project)).toEqual([
      `adding target 'agentcore' to gateway '${GATEWAY}' in agentcore.json, for the boxed agent's Memory calls`,
      `adding 'agentcore/box-memory-policy.json' to gateway '${GATEWAY}' additionalPolicies in agentcore.json, so its role can call Memory`,
    ]);
    expect(gateway(project).additionalPolicies).toEqual([BOX_MEMORY_POLICY_FILE]);
    expect(gateway(project).targets).toEqual([getBoxGatewayAgentCoreTargetSpec()]);
  });

  test("changes nothing when the target is already there", () => {
    const project = spec();
    addBoxMemoryTarget(project);

    expect(addBoxMemoryTarget(project)).toEqual([]);
    expect(targets(project)).toEqual(["agentcore"]);
  });

  test("changes nothing for another Memory, or for a runtime that does not run in a box", () => {
    const otherMemory = spec({ memories: ["ordersMemory"] });
    const unboxed = spec({ entrypoint: "main.py" });

    expect(addBoxMemoryTarget(otherMemory)).toEqual([]);
    expect(addBoxMemoryTarget(unboxed)).toEqual([]);
    expect(targets(otherMemory)).toEqual([]);
    expect(targets(unboxed)).toEqual([]);
  });

  test("changes nothing in a project that is not a Box project", () => {
    const { projectType: _omitted, ...rest } = spec();
    const project = { ...rest, agentCoreGateways: [] } as ProjectSpec;

    expect(addBoxMemoryTarget(project)).toEqual([]);
    expect(project.agentCoreGateways).toEqual([]);
    expect(project.projectType).toBeUndefined();
  });

  test("adds no agentcore target where another target serves its endpoint", () => {
    const project = spec();
    gateway(project).targets = [{ ...getBoxGatewayAgentCoreTargetSpec(), name: "mem" }];

    addBoxMemoryTarget(project);

    expect(targets(project)).toEqual(["mem"]);
    expect(gateway(project).additionalPolicies).toEqual([BOX_MEMORY_POLICY_FILE]);
  });

  test("refuses the target name on a gateway that is not a Box gateway", () => {
    const project = spec();
    project.agentCoreGateways.push({
      name: "tools",
      authorizerType: "AWS_IAM",
      targets: [getBoxGatewayAgentCoreTargetSpec()],
    } as ProjectSpec["agentCoreGateways"][number]);

    expect(() => addBoxMemoryTarget(project)).toThrow(InputValidationError);
  });

  test("lists the policy file on a gateway that already has the target", () => {
    const project = spec();
    gateway(project).targets.push(getBoxGatewayAgentCoreTargetSpec());

    expect(addBoxMemoryTarget(project)).toEqual([
      `adding 'agentcore/box-memory-policy.json' to gateway '${GATEWAY}' additionalPolicies in agentcore.json, so its role can call Memory`,
    ]);
    expect(targets(project)).toEqual(["agentcore"]);
  });

  test("leaves the policies of a gateway that imports its role", () => {
    const project = spec();
    gateway(project).executionRoleArn = "arn:aws:iam::123456789012:role/mine";

    addBoxMemoryTarget(project);

    expect(gateway(project).additionalPolicies).toBeUndefined();
  });
});

describe("boxMemoryPolicy", () => {
  type Policy = {
    Statement: Array<{ Action: string[]; Resource: string[]; Condition: unknown }>;
  };
  const SAME_ACCOUNT = { StringEquals: { "aws:ResourceAccount": "${aws:PrincipalAccount}" } };

  test("allows the Memory data plane on the default Memory in any target, in the gateway role's account", () => {
    const policy = boxMemoryPolicy(spec(), "us-west-2") as Policy;

    expect(policy.Statement[0]!.Resource).toEqual([
      "arn:aws:bedrock-agentcore:us-west-2:*:memory/demo_*agentMemory-*",
    ]);
    expect(policy.Statement[0]!.Condition).toEqual(SAME_ACCOUNT);
    expect(policy.Statement[0]!.Action).toContain("bedrock-agentcore:ListEvents");
    expect(policy.Statement[0]!.Action).toContain("bedrock-agentcore:CreateEvent");
  });

  test("names the region it is given, and no other", () => {
    const policy = boxMemoryPolicy(spec(), "eu-central-1") as Policy;

    expect(policy.Statement).toEqual([
      expect.objectContaining({
        Resource: ["arn:aws:bedrock-agentcore:eu-central-1:*:memory/demo_*agentMemory-*"],
        Condition: SAME_ACCOUNT,
      }),
    ]);
  });

  test("names the partition of the region it is given", () => {
    const resources = (region: string) =>
      (boxMemoryPolicy(spec(), region) as Policy).Statement[0]!.Resource;

    expect(resources("cn-north-1")).toEqual([
      "arn:aws-cn:bedrock-agentcore:cn-north-1:*:memory/demo_*agentMemory-*",
    ]);
    expect(resources("us-gov-west-1")).toEqual([
      "arn:aws-us-gov:bedrock-agentcore:us-gov-west-1:*:memory/demo_*agentMemory-*",
    ]);
  });

  test("is undefined when no boxed runtime has its default Memory", () => {
    expect(boxMemoryPolicy(spec({ memories: ["ordersMemory"] }), "us-west-2")).toBeUndefined();
    expect(boxMemoryPolicy(spec({ entrypoint: "main.py" }), "us-west-2")).toBeUndefined();
  });
});

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
  test("adds the bedrock and agentcore targets a boxed agent's calls take, in the region given", () => {
    const project = spec();

    addBoxGatewayTargets(project, "eu-central-1");

    expect(gateway(project).targets).toEqual([
      getBoxGatewayBedrockTargetSpec("eu-central-1"),
      getBoxGatewayAgentCoreTargetSpec("eu-central-1"),
    ]);
  });

  test("moves a target it wrote for another region, and keeps one the user changed", () => {
    const project = spec();
    addBoxGatewayTargets(project, "us-west-2");
    const memory = gateway(project).targets[1]!;
    gateway(project).targets[1] = {
      ...memory,
      outboundAuth: { ...memory.outboundAuth!, region: "eu-west-1" },
    };

    expect(addBoxGatewayTargets(project, "us-east-1")).toEqual([
      `updating target 'bedrock' of gateway '${GATEWAY}' in agentcore.json from us-west-2 to us-east-1`,
    ]);
    expect(gateway(project).targets[0]).toEqual(getBoxGatewayBedrockTargetSpec("us-east-1"));
    expect(gateway(project).targets[1]!.outboundAuth?.region).toBe("eu-west-1");
  });
});
