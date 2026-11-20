import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  InputValidationError,
  ProjectStateError,
  ResourceNotFoundError,
} from "../../errors/errors";
import type { AddResourceInput, Project } from "../../handlers/project/types";
import { resolveRuntimeTemplateShortcut } from "../../handlers/project/shortcuts";
import { createSilentLogger, TestIdentityClient } from "../../testing";
import { BOX_RELEASE } from "./backends/boxRelease";
import { FsProjectManager } from "./manager";
import { newProjectSpec } from "./templates/project";
import { boxGatewaySpec } from "../../projectSchemas/project";

/**
 * `"projectType": "box"` is written by `agentcore create` from a Box template only. A Box project
 * keeps one Box gateway for each runtime: a gateway with `boundRuntime` set to the runtime, written
 * by the CLI. It is created with the runtime, removed with the runtime, refused by `remove gateway`,
 * and takes every target type. The CDK library binds it from its `boundRuntime` and
 * `discoveryPrefix`. A project without the field behaves as before.
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

/**
 * A Box project with the given box runtimes, as `newProjectSpec` writes one for a Box template:
 * `projectType: "box"`, `box.version` on each runtime, and the gateway `<runtime>-box-egress` for
 * each. `add runtime` refuses a Box project, so the runtimes are written here. Two runtimes are a
 * project edited by hand; they check that each gateway stays bound to its own runtime.
 */
async function createdProject(
  manager: FsProjectManager,
  runtimes: string[] = ["agent"],
): Promise<Project> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-box-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  const created = await drain(
    manager.create({ name: "example", skipInstall: true, skipGit: true }),
  );
  const path = join(created.rootPath, "agentcore", "agentcore.json");
  const spec = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const boxRuntimes = runtimes.map((name) => ({
    name,
    build: "CodeZip",
    entrypoint: "start.py",
    codeLocation: `app/${name}`,
    runtimeVersion: "PYTHON_3_14",
    protocol: "HTTP",
    box: { version: BOX_RELEASE.version },
  }));
  for (const name of runtimes)
    await mkdir(join(created.rootPath, "app", name), { recursive: true });
  await writeFile(
    path,
    JSON.stringify(
      {
        ...spec,
        ...newProjectSpec("example", [{ projectType: "box", runtimes: boxRuntimes as never }]),
      },
      null,
      2,
    ),
  );
  return (await manager.resolve({ filePath: created.rootPath }))!;
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
  test("writes no projectType and no Box gateway without a Box template", async () => {
    const manager = subject();
    const directory = await mkdtemp(join(tmpdir(), "agentcore-box-"));
    tempDirectories.push(directory);
    process.chdir(directory);

    const project = await drain(
      manager.create({ name: "example", skipInstall: true, skipGit: true }),
    );

    const spec = await specOnDisk(project);
    expect("projectType" in spec).toBe(false);
    expect(spec.agentCoreGateways ?? []).toEqual([]);
  });

  test.each([
    ["agent-python-strands-box", "box"],
    ["agent-python-strands-box-container", "box"],
    ["agent-python-strands", undefined],
    ["agent-python-strands-container", undefined],
    ["agent-python-minimal", undefined],
  ] as const)("create --template %s writes projectType %p", async (template, projectType) => {
    const manager = subject();
    const directory = await mkdtemp(join(tmpdir(), "agentcore-box-"));
    tempDirectories.push(directory);
    process.chdir(directory);

    const project = await drain(
      manager.create({
        name: "example",
        skipInstall: true,
        skipGit: true,
        scaffoldRuntimeInput: resolveRuntimeTemplateShortcut(template, { runtimeName: "agent" }),
      }),
    );

    // Only a box template runs its agent in a box, so only it makes a Box project.
    const spec = await specOnDisk(project);
    expect(spec.projectType).toBe(projectType);
    expect((spec.agentCoreGateways ?? []).map(({ name }) => name)).toEqual(
      projectType ? ["agent-box-egress"] : [],
    );
  });

  test('a Box template writes "projectType": "box" and a Box gateway for each runtime', () => {
    const runtime = (name: string) =>
      ({ name, build: "CodeZip", entrypoint: "main.py", codeLocation: `app/${name}` }) as never;

    const spec = newProjectSpec("example", [
      { projectType: "box", runtimes: [runtime("agent")] },
      { runtimes: [runtime("my_agent")] },
    ]);

    expect(spec.projectType).toBe("box");
    expect(spec.agentCoreGateways).toEqual([boxGatewaySpec("agent"), boxGatewaySpec("my_agent")]);
    expect(boxGatewaySpec("my_agent")).toMatchObject({
      name: "my-agent-box-egress",
      authorizerType: "AWS_IAM",
      protocolType: "None",
      boundRuntime: "my_agent",
      discoveryPrefix: "AGENTCORE_GATEWAY_BOX",
      enableApplicationLogs: true,
      targets: [],
    });
  });

  test("templates that are not Box templates write no projectType and no gateway", () => {
    const spec = newProjectSpec("example", [{ runtimes: [{ name: "agent" } as never] }]);
    expect("projectType" in spec).toBe(false);
    expect("agentCoreGateways" in spec).toBe(false);
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

  test("--gateway box is not found", async () => {
    const manager = subject();
    const project = await createdProject(manager, ["agent", "my_agent"]);

    const add = drain(manager.addResource(project, boxTarget("weather", "box")));

    await expect(add).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(add).rejects.toThrow("no gateway named 'box' exists in this project");
  });

  test("add gateway-target adds an MCP target to the Box gateway", async () => {
    const manager = subject();
    const project = await createdProject(manager);

    await drain(manager.addResource(project, mcpTarget("search")));

    const spec = await specOnDisk(project);
    expect(spec.agentCoreGateways).toMatchObject([
      { name: "agent-box-egress", targets: [{ name: "search", targetType: "mcpServer" }] },
    ]);
  });

  test("add gateway --name box is refused, because its variable prefix is the Box gateway's", async () => {
    const manager = subject();
    const project = await createdProject(manager);
    const before = await specText(project);

    const add = drain(
      manager.addResource(project, {
        resourceType: "gateway",
        resourceConfig: { name: "box", targets: [], authorizerType: "NONE" } as never,
      }),
    );

    await expect(add).rejects.toThrow(
      'Gateways "box" and "agent-box-egress" both set AGENTCORE_GATEWAY_BOX_* on runtime "agent".',
    );
    expect(await specText(project)).toBe(before);
  });

  test("add runtime is refused, and changes nothing: a Box project holds one runtime", async () => {
    const manager = subject();
    const project = await createdProject(manager);
    const before = await specText(project);

    const add = drain(
      manager.addResource(project, {
        resourceType: "runtime",
        resourceConfig: { name: "search", language: "Python", protocol: "HTTP" },
      } as never),
    );

    await expect(add).rejects.toBeInstanceOf(ProjectStateError);
    await expect(add).rejects.toThrow(
      "cannot add runtime 'search': a Box project holds one runtime, which `agentcore create` " +
        "makes from a box template",
    );
    expect(await specText(project)).toBe(before);
    expect(existsSync(join(project.rootPath, "app", "search"))).toBe(false);
  });

  test("add gateway --name other-box-egress works: only the prefix must be unique", async () => {
    const manager = subject();
    let project = await createdProject(manager);

    project = await drain(
      manager.addResource(project, {
        resourceType: "gateway",
        resourceConfig: { name: "other-box-egress", targets: [], authorizerType: "NONE" } as never,
      }),
    );

    expect((await specOnDisk(project)).agentCoreGateways.map(({ name }) => name)).toEqual([
      "agent-box-egress",
      "other-box-egress",
    ]);
  });

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
    await expect(remove).rejects.toThrow(
      "the gateway 'agent-box-egress' is bound to runtime 'agent' and cannot be removed",
    );
    const spec = await specOnDisk(project);
    expect(spec.agentCoreGateways.map(({ name }) => name)).toEqual(["agent-box-egress"]);
    expect(spec.projectType).toBe("box");
  });

  test("remove runtime also removes the entry of its Box gateway", async () => {
    const manager = subject();
    let project = await createdProject(manager, ["agent", "my_agent"]);
    project = await drain(manager.addResource(project, boxTarget("weather")));
    project = await drain(manager.addResource(project, boxTarget("search", "my-agent-box-egress")));

    const result = await manager.removeResource(project, {
      resourceType: "runtime",
      name: "agent",
    });

    const spec = await specOnDisk(result.project);
    expect(spec.agentCoreGateways.map(({ name }) => name)).toEqual(["my-agent-box-egress"]);
    expect(result.removedGateways).toEqual([{ name: "agent-box-egress", targetCount: 1 }]);
  });

  test("remove runtime finds the gateways to remove by boundRuntime", async () => {
    const manager = subject();
    let project = await createdProject(manager, ["agent", "search"]);
    // A gateway bound to the runtime, with a name that is not the Box gateway name.
    const path = join(project.rootPath, "agentcore", "agentcore.json");
    const onDisk = await specOnDisk(project);
    onDisk.agentCoreGateways.push({
      name: "agent-extra",
      authorizerType: "AWS_IAM",
      boundRuntime: "agent",
      targets: [],
    } as never);
    await writeFile(path, JSON.stringify(onDisk, null, 2));
    project = (await manager.resolve({ filePath: project.rootPath }))!;

    const result = await manager.removeResource(project, {
      resourceType: "runtime",
      name: "agent",
    });

    expect((await specOnDisk(result.project)).agentCoreGateways.map(({ name }) => name)).toEqual([
      "search-box-egress",
    ]);
    expect(result.removedGateways.map(({ name }) => name)).toEqual([
      "agent-box-egress",
      "agent-extra",
    ]);
  });

  test("remove all removes every gateway entry and keeps projectType", async () => {
    const manager = subject();
    let project = await createdProject(manager);
    project = await drain(manager.addResource(project, boxTarget("weather")));

    const result = await manager.removeAllResources(project);

    const spec = await specOnDisk(result.project);
    expect(spec.projectType).toBe("box");
    expect(spec.agentCoreGateways).toEqual([]);
  });

  test("remove all, then add runtime, is refused, as the project is still a Box project", async () => {
    const manager = subject();
    let project = await createdProject(manager);
    project = (await manager.removeAllResources(project)).project;

    const add = drain(
      manager.addResource(project, {
        resourceType: "runtime",
        resourceConfig: { name: "agent", language: "Python", protocol: "HTTP" },
      } as never),
    );

    await expect(add).rejects.toBeInstanceOf(ProjectStateError);
    expect((await specOnDisk(project)).agentCoreGateways).toEqual([]);
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
