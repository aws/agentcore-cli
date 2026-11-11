import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceNotFoundError } from "../../errors/errors";
import type { AddResourceInput, Project } from "../../handlers/project/types";
import { createSilentLogger, TestIdentityClient } from "../../testing";
import { FsProjectManager } from "./manager";

/**
 * The Box marker (`"box": {}`) is written by `agentcore create` only. In a project with the
 * marker, the gateway entry named `box` holds the targets of the Box gateway, which the CDK library
 * makes from the marker, so the entry comes and goes with its targets. A project without the marker
 * behaves as before and never gets the marker.
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

async function createdProject(manager: FsProjectManager): Promise<Project> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-box-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  return drain(manager.create({ name: "example", skipInstall: true, skipGit: true }));
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

const mcpTarget = (name: string): AddResourceInput => ({
  resourceType: "gateway-target",
  gatewayName: "box",
  resourceConfig: {
    name,
    targetType: "mcpServer",
    endpoint: `https://${name}.example.com/mcp`,
  },
});

describe("agentcore create", () => {
  test('writes "box": {} into the new project', async () => {
    const project = await createdProject(subject());

    expect((await specOnDisk(project)).box).toEqual({});
    expect(project.spec.box).toEqual({});
  });
});

describe("gateway targets in a Box project", () => {
  test("add gateway-target --gateway box makes the entry with AWS_IAM, then adds to it", async () => {
    const manager = subject();
    let project = await createdProject(manager);

    project = await drain(manager.addResource(project, mcpTarget("weather")));
    project = await drain(manager.addResource(project, mcpTarget("search")));

    const spec = await specOnDisk(project);
    expect(spec.box).toEqual({});
    expect(spec.agentCoreGateways).toEqual([
      {
        name: "box",
        targets: [
          { name: "weather", targetType: "mcpServer", endpoint: "https://weather.example.com/mcp" },
          { name: "search", targetType: "mcpServer", endpoint: "https://search.example.com/mcp" },
        ],
        authorizerType: "AWS_IAM",
        enableSemanticSearch: true,
        exceptionLevel: "NONE",
      },
    ] as never);
  });

  test("remove gateway-target keeps the entry until its last target goes", async () => {
    const manager = subject();
    let project = await createdProject(manager);
    project = await drain(manager.addResource(project, mcpTarget("weather")));
    project = await drain(manager.addResource(project, mcpTarget("search")));

    project = (
      await manager.removeResource(project, {
        resourceType: "gateway-target",
        gatewayName: "box",
        name: "weather",
      })
    ).project;
    expect((await specOnDisk(project)).agentCoreGateways.map(({ name }) => name)).toEqual(["box"]);

    project = (
      await manager.removeResource(project, {
        resourceType: "gateway-target",
        gatewayName: "box",
        name: "search",
      })
    ).project;
    const spec = await specOnDisk(project);
    expect(spec.agentCoreGateways).toEqual([]);
    expect(spec.box).toEqual({});
  });

  test("remove gateway --name box removes the entry and its targets, and keeps the marker", async () => {
    const manager = subject();
    let project = await createdProject(manager);
    project = await drain(manager.addResource(project, mcpTarget("weather")));

    project = (await manager.removeResource(project, { resourceType: "gateway", name: "box" }))
      .project;

    const spec = await specOnDisk(project);
    expect(spec.agentCoreGateways).toEqual([]);
    expect(spec.box).toEqual({});
  });

  test("remove all removes the marker with every gateway entry", async () => {
    const manager = subject();
    let project = await createdProject(manager);
    project = await drain(manager.addResource(project, mcpTarget("weather")));

    const result = await manager.removeAllResources(project);

    const spec = await specOnDisk(result.project);
    expect("box" in spec).toBe(false);
    expect(spec.agentCoreGateways).toEqual([]);
    expect(result.project.spec.box).toBeUndefined();
  });
});

describe("a project without the Box marker", () => {
  test("add gateway-target --gateway box fails as before and adds no marker", async () => {
    const manager = subject();
    const project = await existingProject(manager);

    const add = drain(manager.addResource(project, mcpTarget("weather")));

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
    project = await drain(manager.addResource(project, mcpTarget("weather")));

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
    expect("box" in spec).toBe(false);
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
