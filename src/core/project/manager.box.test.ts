import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InputValidationError, ResourceNotFoundError } from "../../errors/errors";
import type { AddResourceInput, Project } from "../../handlers/project/types";
import { createSilentLogger, TestIdentityClient } from "../../testing";
import { FsProjectManager } from "./manager";

/**
 * `"projectType": "box"` is written by `agentcore create` only. A Box project keeps one Box
 * gateway for each runtime, `<runtime>-box-egress`, written by the CLI: created with the runtime,
 * removed with the runtime, and refused by `remove gateway`. The CDK library binds it from its
 * `boundRuntime` and `discoveryPrefix`. A project without the field behaves as before.
 */

const tempDirectories: string[] = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function subject(): FsProjectManager {
  return new FsProjectManager({
    logger: createSilentLogger(),
    identity: new TestIdentityClient(),
    enableTransactionSearch: async () => {},
    runner: async () => {},
    checkTool: async () => {},
  });
}

async function drain<T>(generator: AsyncGenerator<unknown, T>): Promise<T> {
  while (true) {
    const next = await generator.next();
    if (next.done) return next.value;
  }
}

/** A new Box project with the given runtimes. Each runtime gets the gateway `<runtime>-box-egress`. */
async function createdProject(
  manager: FsProjectManager,
  runtimes: string[] = ["agent"],
): Promise<Project> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-box-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  let project = await drain(manager.create({ name: "example", skipInstall: true, skipGit: true }));
  for (const name of runtimes) {
    project = await drain(
      manager.addResource(project, {
        resourceType: "runtime",
        resourceConfig: { name, language: "Python", protocol: "HTTP" },
      } as never),
    );
  }
  return project;
}

/** The agentcore.json of MyTemp3, a project made with CLI 1.0.0, as that CLI wrote it. */
const EXISTING_PROJECT_JSON = `${JSON.stringify(
  {
    name: "MyTemp3",
    version: 2,
    managedBy: "CDK",
    runtimes: [
      {
        name: "agent",
        modelProvider: "Bedrock",
        build: "CodeZip",
        entrypoint: "main.py",
        codeLocation: "app/agent",
        runtimeVersion: "PYTHON_3_14",
        protocol: "HTTP",
      },
    ],
    memories: [
      {
        name: "agentMemory",
        eventExpiryDuration: 30,
        strategies: [{ type: "SEMANTIC", namespaceTemplates: ["/users/{actorId}/facts"] }],
      },
    ],
    knowledgeBases: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    agentCoreGateways: [],
    policyEngines: [],
    configBundles: [],
    harnesses: [],
  },
  null,
  2,
)}`;

async function existingProject(manager: FsProjectManager): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), "agentcore-box-existing-"));
  tempDirectories.push(root);
  await mkdir(join(root, "agentcore"), { recursive: true });
  await mkdir(join(root, "app", "agent"), { recursive: true });
  await writeFile(join(root, "agentcore", "agentcore.json"), EXISTING_PROJECT_JSON);
  await writeFile(join(root, "agentcore", "aws-targets.json"), "[]\n");
  const project = await manager.resolve({ filePath: root });
  if (!project) throw new Error("expected the fixture project to resolve");
  return project;
}

const specText = (project: Project) =>
  readFile(join(project.rootPath, "agentcore", "agentcore.json"), "utf8");
const specOnDisk = async (project: Project) =>
  JSON.parse(await specText(project)) as Record<string, unknown> & {
    agentCoreGateways: { name: string; targets: { name: string }[] }[];
  };

const boxTarget = (name: string, gatewayName = "agent-box-egress"): AddResourceInput => ({
  resourceType: "gateway-target",
  gatewayName,
  resourceConfig: {
    name,
    targetType: "passthrough",
    passthrough: { endpoint: `https://${name}.example.com` },
    outboundAuth: { type: "GATEWAY_IAM_ROLE", service: "execute-api" },
  } as never,
});

const mcpTarget = (name: string, gatewayName = "agent-box-egress"): AddResourceInput => ({
  resourceType: "gateway-target",
  gatewayName,
  resourceConfig: {
    name,
    targetType: "mcpServer",
    endpoint: `https://${name}.example.com/mcp`,
  },
});

describe("agentcore create", () => {
  test('writes "projectType": "box" and a Box gateway for each runtime', async () => {
    const project = await createdProject(subject(), ["agent", "my_agent"]);

    const spec = await specOnDisk(project);
    expect(spec.projectType).toBe("box");
    expect(project.spec.projectType).toBe("box");
    expect(spec.agentCoreGateways).toMatchObject([
      {
        name: "agent-box-egress",
        authorizerType: "AWS_IAM",
        protocolType: "None",
        boundRuntime: "agent",
        discoveryPrefix: "AGENTCORE_GATEWAY_BOX",
        targets: [],
      },
      {
        name: "my-agent-box-egress",
        boundRuntime: "my_agent",
        discoveryPrefix: "AGENTCORE_GATEWAY_BOX",
        targets: [],
      },
    ]);
  });
});

describe("gateway targets in a Box project", () => {
  test("add gateway-target --gateway agent-box-egress adds to the existing entry", async () => {
    const manager = subject();
    let project = await createdProject(manager);

    project = await drain(manager.addResource(project, boxTarget("weather")));
    project = await drain(manager.addResource(project, boxTarget("search")));

    const spec = await specOnDisk(project);
    expect(spec.projectType).toBe("box");
    expect(spec.agentCoreGateways).toMatchObject([
      {
        name: "agent-box-egress",
        authorizerType: "AWS_IAM",
        protocolType: "None",
        boundRuntime: "agent",
        discoveryPrefix: "AGENTCORE_GATEWAY_BOX",
        targets: ["weather", "search"].map((name) => ({ name, targetType: "passthrough" })),
      },
    ]);
  });

  test("adds a target only to the gateway of its runtime, and changes _ to -", async () => {
    const manager = subject();
    let project = await createdProject(manager, ["agent", "my_agent"]);

    project = await drain(
      manager.addResource(project, boxTarget("weather", "my-agent-box-egress")),
    );

    const spec = await specOnDisk(project);
    expect(
      spec.agentCoreGateways.map(({ name, targets }) => [name, targets.map((t) => t.name)]),
    ).toEqual([
      ["agent-box-egress", []],
      ["my-agent-box-egress", ["weather"]],
    ]);
  });

  test("--gateway box is not found, and the error lists the Box gateways", async () => {
    const manager = subject();
    const project = await createdProject(manager, ["agent", "my_agent"]);

    const add = drain(manager.addResource(project, boxTarget("weather", "box")));

    await expect(add).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(add).rejects.toThrow(
      "no gateway named 'box' exists in this project. The Box gateways in this project are: 'agent-box-egress', 'my-agent-box-egress'.",
    );
  });

  test("add gateway-target refuses an MCP target and writes nothing", async () => {
    const manager = subject();
    const project = await createdProject(manager);
    const before = await specText(project);

    await expect(drain(manager.addResource(project, mcpTarget("search")))).rejects.toThrow(
      "the Box gateway takes only passthrough targets, but target 'search' is mcpServer.",
    );
    expect(await specText(project)).toBe(before);
  });

  test.each(["AGENT-BOX-EGRESS", "other-box-egress"])(
    "add gateway --name %s is refused, because names that end in -box-egress are reserved",
    async (name) => {
      const manager = subject();
      const project = await createdProject(manager);
      const before = await specText(project);

      const add = drain(
        manager.addResource(project, {
          resourceType: "gateway",
          resourceConfig: { name, targets: [], authorizerType: "NONE" } as never,
        }),
      );

      await expect(add).rejects.toThrow(
        `the gateway name '${name}' is reserved: in this project, names that end in '-box-egress' belong to the Box gateways of the runtimes.`,
      );
      await expect(add).rejects.toThrow(
        "The Box gateways in this project are: 'agent-box-egress'.",
      );
      expect(await specText(project)).toBe(before);
    },
  );

  test("remove gateway-target keeps the entry after its last target goes", async () => {
    const manager = subject();
    let project = await createdProject(manager);
    project = await drain(manager.addResource(project, boxTarget("weather")));

    project = (
      await manager.removeResource(project, {
        resourceType: "gateway-target",
        gatewayName: "agent-box-egress",
        name: "weather",
      })
    ).project;

    const spec = await specOnDisk(project);
    expect(spec.agentCoreGateways.map(({ name, targets }) => [name, targets])).toEqual([
      ["agent-box-egress", []],
    ]);
    expect(spec.projectType).toBe("box");
  });

  test("remove gateway --name agent-box-egress is refused", async () => {
    const manager = subject();
    let project = await createdProject(manager);
    project = await drain(manager.addResource(project, boxTarget("weather")));

    const remove = manager.removeResource(project, {
      resourceType: "gateway",
      name: "agent-box-egress",
    });

    await expect(remove).rejects.toBeInstanceOf(InputValidationError);
    await expect(remove).rejects.toThrow("is a Box gateway and cannot be removed");
    const spec = await specOnDisk(project);
    expect(spec.agentCoreGateways.map(({ name }) => name)).toEqual(["agent-box-egress"]);
    expect(spec.projectType).toBe("box");
  });

  test("remove runtime also removes the entry of its Box gateway", async () => {
    const manager = subject();
    let project = await createdProject(manager, ["agent", "my_agent"]);
    project = await drain(manager.addResource(project, boxTarget("weather")));
    project = await drain(manager.addResource(project, boxTarget("search", "my-agent-box-egress")));

    project = (await manager.removeResource(project, { resourceType: "runtime", name: "agent" }))
      .project;

    const spec = await specOnDisk(project);
    expect(spec.agentCoreGateways.map(({ name }) => name)).toEqual(["my-agent-box-egress"]);
  });

  test("remove all removes projectType with every gateway entry", async () => {
    const manager = subject();
    let project = await createdProject(manager);
    project = await drain(manager.addResource(project, boxTarget("weather")));

    const result = await manager.removeAllResources(project);

    const spec = await specOnDisk(result.project);
    expect("projectType" in spec).toBe(false);
    expect(spec.agentCoreGateways).toEqual([]);
    expect(result.project.spec.projectType).toBeUndefined();
  });
});

describe("a project without projectType", () => {
  test("add gateway-target --gateway box fails as before and adds no projectType", async () => {
    const manager = subject();
    const project = await existingProject(manager);

    const add = drain(manager.addResource(project, mcpTarget("weather", "box")));

    await expect(add).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(add).rejects.toThrow("no gateway named 'box' exists in this project");
    expect(await specText(project)).toBe(EXISTING_PROJECT_JSON);
  });

  test("keeps a normal gateway named box when its last target goes", async () => {
    const manager = subject();
    let project = await existingProject(manager);
    project = await drain(
      manager.addResource(project, {
        resourceType: "gateway",
        resourceConfig: { name: "box", targets: [], authorizerType: "NONE" } as never,
      }),
    );
    project = await drain(manager.addResource(project, mcpTarget("weather", "box")));

    project = (
      await manager.removeResource(project, {
        resourceType: "gateway-target",
        gatewayName: "box",
        name: "weather",
      })
    ).project;

    const spec = await specOnDisk(project);
    expect(spec.agentCoreGateways.map(({ name, targets }) => [name, targets])).toEqual([
      ["box", []],
    ]);
    expect("projectType" in spec).toBe(false);
  });

  test("add and remove round trips leave agentcore.json as it was", async () => {
    const manager = subject();
    let project = await existingProject(manager);
    const keys = Object.keys(JSON.parse(EXISTING_PROJECT_JSON) as object);

    project = await drain(
      manager.addResource(project, {
        resourceType: "memory",
        resourceConfig: { name: "extra", eventExpiryDuration: 30, strategies: [] },
      }),
    );
    project = await drain(
      manager.addResource(project, {
        resourceType: "gateway",
        resourceConfig: { name: "tools", targets: [], authorizerType: "NONE" } as never,
      }),
    );
    project = await drain(
      manager.addResource(project, { ...mcpTarget("weather"), gatewayName: "tools" } as never),
    );
    expect(Object.keys(await specOnDisk(project))).toEqual(keys);

    project = (
      await manager.removeResource(project, {
        resourceType: "gateway-target",
        gatewayName: "tools",
        name: "weather",
      })
    ).project;
    project = (await manager.removeResource(project, { resourceType: "gateway", name: "tools" }))
      .project;
    project = (await manager.removeResource(project, { resourceType: "memory", name: "extra" }))
      .project;

    expect(await specText(project)).toBe(EXISTING_PROJECT_JSON);
  });
});
