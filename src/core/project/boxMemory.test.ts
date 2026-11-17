import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputValidationError } from "../../errors/errors";
import {
  getBoxGatewayAgentCoreTargetSpec,
  getBoxGatewayBedrockEntry,
} from "../../handlers/project/shortcuts";
import type { ProjectSpec } from "../../projectSchemas/project";
import {
  addBoxBedrockTarget,
  addBoxGatewayTargets,
  addBoxMemoryTarget,
  BOX_MEMORY_POLICY_FILE,
  boxMemoryPolicy,
} from "./boxMemory";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "box-memory-"));
  directories.push(directory);
  return directory;
}

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
    agentCoreGateways: [getBoxGatewayBedrockEntry("agent")],
  } as unknown as ProjectSpec;
}

const targets = (project: ProjectSpec) =>
  project.agentCoreGateways
    .find(({ name }) => name === "agent-box")
    ?.targets.map(({ name }) => name);

describe("addBoxMemoryTarget", () => {
  test("adds the agentcore target for a boxed runtime's default Memory", async () => {
    const project = spec();

    expect(addBoxMemoryTarget(project, await root())).toEqual([
      "adding target 'agentcore' to gateway 'agent-box' in agentcore.json, for the boxed agent's Memory calls",
      "adding 'agentcore/box-memory-policy.json' to gateway 'agent-box' additionalPolicies in agentcore.json, so its role can call Memory",
    ]);
    expect(project.agentCoreGateways[0]!.additionalPolicies).toEqual([BOX_MEMORY_POLICY_FILE]);
    expect(targets(project)).toEqual(["bedrock", "agentcore"]);
    expect(project.agentCoreGateways[0]!.targets[1]).toEqual(getBoxGatewayAgentCoreTargetSpec());
  });

  test("changes nothing when the target is already there", async () => {
    const project = spec();
    const directory = await root();
    addBoxMemoryTarget(project, directory);

    expect(addBoxMemoryTarget(project, directory)).toEqual([]);
    expect(targets(project)).toEqual(["bedrock", "agentcore"]);
  });

  test("changes nothing for another Memory, or for a runtime that does not run in a box", async () => {
    const otherMemory = spec({ memories: ["ordersMemory"] });
    const unboxed = spec({ entrypoint: "main.py" });

    expect(addBoxMemoryTarget(otherMemory, await root())).toEqual([]);
    expect(addBoxMemoryTarget(unboxed, await root())).toEqual([]);
    expect(targets(otherMemory)).toEqual(["bedrock"]);
    expect(targets(unboxed)).toEqual(["bedrock"]);
  });

  test("recreates a removed box gateway entry with the agentcore target", async () => {
    const project = { ...spec(), agentCoreGateways: [] } as ProjectSpec;

    expect(addBoxMemoryTarget(project, await root())).toContain(
      "adding gateway 'agent-box' to agentcore.json",
    );
    expect(targets(project)).toEqual(["agentcore"]);
  });

  test("marks a project without projectType as a Box project", async () => {
    const { projectType: _omitted, ...rest } = spec();
    const project = rest as ProjectSpec;

    expect(addBoxMemoryTarget(project, await root())).toContain(
      `setting "projectType": "box" in agentcore.json, for the Box gateway`,
    );
    expect(project.projectType).toBe("box");
  });

  test("refuses the target name on another gateway", async () => {
    const project = spec();
    project.agentCoreGateways.push({
      ...project.agentCoreGateways[0]!,
      name: "tools",
      targets: [getBoxGatewayAgentCoreTargetSpec()],
    });

    expect(async () => addBoxMemoryTarget(project, await root())).toThrow(InputValidationError);
  });

  test("lists the policy file on a gateway that already has the target", async () => {
    const project = spec();
    project.agentCoreGateways[0]!.targets.push(getBoxGatewayAgentCoreTargetSpec());

    expect(addBoxMemoryTarget(project, await root())).toEqual([
      "adding 'agentcore/box-memory-policy.json' to gateway 'agent-box' additionalPolicies in agentcore.json, so its role can call Memory",
    ]);
    expect(targets(project)).toEqual(["bedrock", "agentcore"]);
  });

  test("leaves the policies of a gateway that imports its role", async () => {
    const project = spec();
    project.agentCoreGateways[0]!.executionRoleArn = "arn:aws:iam::123456789012:role/mine";

    addBoxMemoryTarget(project, await root());

    expect(project.agentCoreGateways[0]!.additionalPolicies).toBeUndefined();
  });
});

describe("boxMemoryPolicy", () => {
  test("allows the Memory data plane on the default Memory in any target", async () => {
    const policy = boxMemoryPolicy(spec(), await root()) as {
      Statement: Array<{ Action: string[]; Resource: string[] }>;
    };

    expect(policy.Statement[0]!.Resource).toEqual([
      "arn:aws:bedrock-agentcore:*:*:memory/demo_*agentMemory-*",
    ]);
    expect(policy.Statement[0]!.Action).toContain("bedrock-agentcore:ListEvents");
    expect(policy.Statement[0]!.Action).toContain("bedrock-agentcore:CreateEvent");
  });

  test("is undefined when no boxed runtime has its default Memory", async () => {
    expect(boxMemoryPolicy(spec({ memories: ["ordersMemory"] }), await root())).toBeUndefined();
    expect(boxMemoryPolicy(spec({ entrypoint: "main.py" }), await root())).toBeUndefined();
  });
});

describe("addBoxBedrockTarget", () => {
  const without = (project: ProjectSpec) => {
    project.agentCoreGateways[0]!.targets = [];
    return project;
  };

  test("puts back the bedrock target a boxed Bedrock agent's route needs", async () => {
    const project = without(spec());

    expect(addBoxBedrockTarget(project, await root())).toEqual([
      "adding target 'bedrock' to gateway 'agent-box' in agentcore.json, for the boxed agent's model calls",
    ]);
    expect(targets(project)).toEqual(["bedrock"]);
  });

  test("changes nothing when the target is there", async () => {
    const project = spec();

    expect(addBoxBedrockTarget(project, await root())).toEqual([]);
    expect(targets(project)).toEqual(["bedrock"]);
  });

  test.each([
    ["another model provider", { modelProvider: "OpenAI" }],
    ["an MCP server", { protocol: "MCP" }],
    ["an agent not in a box", { entrypoint: "main.py" }],
  ])("adds no target for %s", async (_, runtime) => {
    const project = without(spec());
    Object.assign(project.runtimes[0]!, runtime);

    expect(addBoxBedrockTarget(project, await root())).toEqual([]);
    expect(targets(project)).toEqual([]);
  });

  test("recreates a removed Box gateway entry", async () => {
    const project = spec();
    project.agentCoreGateways = [];

    expect(addBoxBedrockTarget(project, await root())).toContain(
      "adding gateway 'agent-box' to agentcore.json",
    );
    expect(targets(project)).toEqual(["bedrock"]);
  });
});

describe("addBoxGatewayTargets", () => {
  test("adds the bedrock and agentcore targets a boxed agent's calls take", async () => {
    const project = spec();
    project.agentCoreGateways[0]!.targets = [];

    addBoxGatewayTargets(project, await root());

    expect(targets(project)).toEqual(["bedrock", "agentcore"]);
  });
});
