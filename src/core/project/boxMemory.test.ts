import { describe, expect, test } from "bun:test";
import { InputValidationError } from "../../errors/errors";
import { getBoxGatewayAgentCoreTargetSpec } from "../../handlers/project/shortcuts";
import { boxGatewaySpec, type ProjectSpec } from "../../projectSchemas/project";
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
    agentCoreGateways: [boxGatewaySpec("agent")],
  } as unknown as ProjectSpec;
}

const GATEWAY = "agent-box-egress";

/** A project root with no Dockerfile: these runtimes are CodeZip, so nothing is read from it. */
const ROOT = "/nonexistent-project";

const gateway = (project: ProjectSpec) =>
  project.agentCoreGateways.find(({ name }) => name === GATEWAY)!;

const targets = (project: ProjectSpec) => gateway(project).targets.map(({ name }) => name);

describe("addBoxMemoryTarget", () => {
  test("adds the agentcore target to the runtime's Box gateway for its default Memory", () => {
    const project = spec();

    expect(addBoxMemoryTarget(project, ROOT)).toEqual([
      `adding target 'agentcore' to gateway '${GATEWAY}' in agentcore.json, for the boxed agent's Memory calls`,
      `adding 'agentcore/box-memory-policy.json' to gateway '${GATEWAY}' additionalPolicies in agentcore.json, so its role can call Memory`,
    ]);
    expect(gateway(project).additionalPolicies).toEqual([BOX_MEMORY_POLICY_FILE]);
    expect(gateway(project).targets).toEqual([getBoxGatewayAgentCoreTargetSpec()]);
  });

  test("changes nothing when the target is already there", () => {
    const project = spec();
    addBoxMemoryTarget(project, ROOT);

    expect(addBoxMemoryTarget(project, ROOT)).toEqual([]);
    expect(targets(project)).toEqual(["agentcore"]);
  });

  test("changes nothing for another Memory, or for a runtime that does not run in a box", () => {
    const otherMemory = spec({ memories: ["ordersMemory"] });
    const unboxed = spec({ entrypoint: "main.py" });

    expect(addBoxMemoryTarget(otherMemory, ROOT)).toEqual([]);
    expect(addBoxMemoryTarget(unboxed, ROOT)).toEqual([]);
    expect(targets(otherMemory)).toEqual([]);
    expect(targets(unboxed)).toEqual([]);
  });

  test("changes nothing in a project that is not a Box project", () => {
    const { projectType: _omitted, ...rest } = spec();
    const project = { ...rest, agentCoreGateways: [] } as ProjectSpec;

    expect(addBoxMemoryTarget(project, ROOT)).toEqual([]);
    expect(project.agentCoreGateways).toEqual([]);
    expect(project.projectType).toBeUndefined();
  });

  test("refuses the target name on a gateway that is not a Box gateway", () => {
    const project = spec();
    project.agentCoreGateways.push({
      name: "tools",
      authorizerType: "AWS_IAM",
      targets: [getBoxGatewayAgentCoreTargetSpec()],
    } as ProjectSpec["agentCoreGateways"][number]);

    expect(() => addBoxMemoryTarget(project, ROOT)).toThrow(InputValidationError);
  });

  test("lists the policy file on a gateway that already has the target", () => {
    const project = spec();
    gateway(project).targets.push(getBoxGatewayAgentCoreTargetSpec());

    expect(addBoxMemoryTarget(project, ROOT)).toEqual([
      `adding 'agentcore/box-memory-policy.json' to gateway '${GATEWAY}' additionalPolicies in agentcore.json, so its role can call Memory`,
    ]);
    expect(targets(project)).toEqual(["agentcore"]);
  });

  test("leaves the policies of a gateway that imports its role", () => {
    const project = spec();
    gateway(project).executionRoleArn = "arn:aws:iam::123456789012:role/mine";

    addBoxMemoryTarget(project, ROOT);

    expect(gateway(project).additionalPolicies).toBeUndefined();
  });
});

describe("boxMemoryPolicy", () => {
  test("allows the Memory data plane on the default Memory in any target", () => {
    const policy = boxMemoryPolicy(spec(), ROOT) as {
      Statement: Array<{ Action: string[]; Resource: string[] }>;
    };

    expect(policy.Statement[0]!.Resource).toEqual([
      "arn:aws:bedrock-agentcore:*:*:memory/demo_*agentMemory-*",
    ]);
    expect(policy.Statement[0]!.Action).toContain("bedrock-agentcore:ListEvents");
    expect(policy.Statement[0]!.Action).toContain("bedrock-agentcore:CreateEvent");
  });

  test("is undefined when no boxed runtime has its default Memory", () => {
    expect(boxMemoryPolicy(spec({ memories: ["ordersMemory"] }), ROOT)).toBeUndefined();
    expect(boxMemoryPolicy(spec({ entrypoint: "main.py" }), ROOT)).toBeUndefined();
  });
});
