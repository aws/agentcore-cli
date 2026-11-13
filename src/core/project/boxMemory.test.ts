import { describe, expect, test } from "bun:test";
import { InputValidationError } from "../../errors/errors";
import {
  getBoxGatewayAgentCoreTargetSpec,
  getBoxGatewaySpec,
} from "../../handlers/project/shortcuts";
import type { ProjectSpec } from "../../projectSchemas/project";
import { addBoxMemoryTarget, BOX_MEMORY_POLICY_FILE, boxMemoryPolicy } from "./boxMemory";

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
      },
    ],
    memories: (options.memories ?? ["agentMemory"]).map((name) => ({
      name,
      eventExpiryDuration: 30,
      strategies: [],
    })),
    agentCoreGateways: [getBoxGatewaySpec({ bedrockTarget: true })],
  } as unknown as ProjectSpec;
}

const targets = (project: ProjectSpec) =>
  project.agentCoreGateways.find(({ name }) => name === "box")?.targets.map(({ name }) => name);

describe("addBoxMemoryTarget", () => {
  test("adds the agentcore target for a boxed runtime's default Memory", () => {
    const project = spec();

    expect(addBoxMemoryTarget(project)).toEqual([
      "adding target 'agentcore' to gateway 'box' in agentcore.json, for the boxed agent's Memory calls",
      "adding 'agentcore/box-memory-policy.json' to gateway 'box' additionalPolicies in agentcore.json, so its role can call Memory",
    ]);
    expect(project.agentCoreGateways[0]!.additionalPolicies).toEqual([BOX_MEMORY_POLICY_FILE]);
    expect(targets(project)).toEqual(["bedrock", "agentcore"]);
    expect(project.agentCoreGateways[0]!.targets[1]).toEqual(getBoxGatewayAgentCoreTargetSpec());
  });

  test("changes nothing when the target is already there", () => {
    const project = spec();
    addBoxMemoryTarget(project);

    expect(addBoxMemoryTarget(project)).toEqual([]);
    expect(targets(project)).toEqual(["bedrock", "agentcore"]);
  });

  test("changes nothing for another Memory, or for a runtime that does not run in a box", () => {
    const otherMemory = spec({ memories: ["ordersMemory"] });
    const unboxed = spec({ entrypoint: "main.py" });

    expect(addBoxMemoryTarget(otherMemory)).toEqual([]);
    expect(addBoxMemoryTarget(unboxed)).toEqual([]);
    expect(targets(otherMemory)).toEqual(["bedrock"]);
    expect(targets(unboxed)).toEqual(["bedrock"]);
  });

  test("recreates a removed box gateway entry with the agentcore target", () => {
    const project = { ...spec(), agentCoreGateways: [] } as ProjectSpec;

    expect(addBoxMemoryTarget(project)).toContain("adding gateway 'box' to agentcore.json");
    expect(targets(project)).toEqual(["agentcore"]);
  });

  test("marks a project without projectType as a Box project", () => {
    const { projectType: _omitted, ...rest } = spec();
    const project = rest as ProjectSpec;

    expect(addBoxMemoryTarget(project)).toContain(
      `setting "projectType": "box" in agentcore.json, for the Box gateway`,
    );
    expect(project.projectType).toBe("box");
  });

  test("refuses the target name on another gateway", () => {
    const project = spec();
    project.agentCoreGateways.push({
      ...project.agentCoreGateways[0]!,
      name: "tools",
      targets: [getBoxGatewayAgentCoreTargetSpec()],
    });

    expect(() => addBoxMemoryTarget(project)).toThrow(InputValidationError);
  });

  test("lists the policy file on a gateway that already has the target", () => {
    const project = spec();
    project.agentCoreGateways[0]!.targets.push(getBoxGatewayAgentCoreTargetSpec());

    expect(addBoxMemoryTarget(project)).toEqual([
      "adding 'agentcore/box-memory-policy.json' to gateway 'box' additionalPolicies in agentcore.json, so its role can call Memory",
    ]);
    expect(targets(project)).toEqual(["bedrock", "agentcore"]);
  });

  test("leaves the policies of a gateway that imports its role", () => {
    const project = spec();
    project.agentCoreGateways[0]!.executionRoleArn = "arn:aws:iam::123456789012:role/mine";

    addBoxMemoryTarget(project);

    expect(project.agentCoreGateways[0]!.additionalPolicies).toBeUndefined();
  });
});

describe("boxMemoryPolicy", () => {
  test("allows the Memory data plane on the default Memory in any target", () => {
    const policy = boxMemoryPolicy(spec()) as {
      Statement: Array<{ Action: string[]; Resource: string[] }>;
    };

    expect(policy.Statement[0]!.Resource).toEqual([
      "arn:aws:bedrock-agentcore:*:*:memory/demo_*agentMemory-*",
    ]);
    expect(policy.Statement[0]!.Action).toContain("bedrock-agentcore:ListEvents");
    expect(policy.Statement[0]!.Action).toContain("bedrock-agentcore:CreateEvent");
  });

  test("is undefined when no boxed runtime has its default Memory", () => {
    expect(boxMemoryPolicy(spec({ memories: ["ordersMemory"] }))).toBeUndefined();
    expect(boxMemoryPolicy(spec({ entrypoint: "main.py" }))).toBeUndefined();
  });
});
