import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { DeserializationError, ProjectStateError } from "../../errors/errors";
import type { AwsDeploymentTarget } from "../../projectSchemas/aws-targets";
import { ProjectSpecSchema } from "../../projectSchemas/project";
import { FsProjectManager } from "./manager";
import {
  RUNTIME_TEMPLATE_SHORTCUTS,
  type CreateProjectInput,
  type DeployResult,
  type Project,
  type ProjectEvent,
  type TeardownConfirmationHandler,
} from "../../handlers/project/types";
import { createSilentLogger } from "../../testing";
import type { DeployBackendInput, ProjectBackend } from "./backends/types";

const HELLO_WORLD_PYTHON = RUNTIME_TEMPLATE_SHORTCUTS["hello-world-python"];
const HELLO_WORLD_PYTHON_CONTAINER = RUNTIME_TEMPLATE_SHORTCUTS["hello-world-python-container"];
const STRANDS_PYTHON = RUNTIME_TEMPLATE_SHORTCUTS["strands-python"];

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-manager-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  // cwd is the realpath (macOS tmpdir lives behind a /var -> /private/var
  // symlink), matching the paths the manager derives from process.cwd().
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

// A manager whose runner records commands instead of spawning them.
function manager(): { manager: FsProjectManager; commands: { command: string[]; cwd: string }[] } {
  const commands: { command: string[]; cwd: string }[] = [];
  return {
    manager: new FsProjectManager({
      logger: createSilentLogger(),
      runner: async (command, { cwd }) => {
        commands.push({ command, cwd });
      },
      checkTool: async () => {}, // CI hosts don't have uv installed
    }),
    commands,
  };
}

async function runCreate(
  subject: FsProjectManager,
  input: CreateProjectInput,
): Promise<{ events: ProjectEvent[]; project: Project }> {
  const iterator = subject.create(input);
  const events: ProjectEvent[] = [];

  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return { events, project: next.value };
    }
    events.push(next.value);
  }
}

async function projectManifest(projectRoot: string): Promise<string[]> {
  return (await readdir(projectRoot, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(projectRoot, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}

describe("FsProjectManager.create", () => {
  test("scaffolds the expected file tree into a fresh directory", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "example",
      scaffoldRuntimeInput: HELLO_WORLD_PYTHON,
    });

    const projectRoot = join(directory, "example");
    expect(await projectManifest(projectRoot)).toMatchSnapshot();
  });

  test("snapshots the Strands project manifest and runtime spec", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "example",
      scaffoldRuntimeInput: STRANDS_PYTHON,
    });

    const projectRoot = join(directory, "example");
    const spec = await Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
    expect({
      manifest: await projectManifest(projectRoot),
      runtimes: spec.runtimes,
    }).toMatchSnapshot();
  });

  test("writes a deploy-ready agentcore.json registering the template agent", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "example",
      scaffoldRuntimeInput: HELLO_WORLD_PYTHON,
    });

    const configDir = join(directory, "example", "agentcore");
    const spec = await Bun.file(join(configDir, "agentcore.json")).json();
    expect(spec.name).toBe("example");
    expect(spec.runtimes).toEqual([
      {
        name: "hello_world",
        build: "CodeZip",
        entrypoint: "main.py",
        codeLocation: "app/hello_world",
        runtimeVersion: "PYTHON_3_14",
      },
    ]);
    expect(await Bun.file(join(configDir, "aws-targets.json")).json()).toEqual([]);
  });

  test("scaffolds the container template with a Dockerfile and .dockerignore", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "example",
      scaffoldRuntimeInput: HELLO_WORLD_PYTHON_CONTAINER,
    });

    const appDir = join(directory, "example", "app", "hello_world");
    // dockerignore.template must render to .dockerignore (the fsTree regex fix).
    expect(await Bun.file(join(appDir, ".dockerignore")).exists()).toBe(true);
    expect(await Bun.file(join(appDir, "dockerignore.template")).exists()).toBe(false);
    expect(await Bun.file(join(appDir, "Dockerfile")).exists()).toBe(true);

    const spec = await Bun.file(join(directory, "example", "agentcore", "agentcore.json")).json();
    expect(spec.runtimes[0]).toMatchObject({ build: "Container", dockerfile: "Dockerfile" });
  });

  test("refuses to overwrite an existing project", async () => {
    await inTempDirectory();
    const input: CreateProjectInput = {
      name: "example",
      scaffoldRuntimeInput: HELLO_WORLD_PYTHON,
    };

    await runCreate(manager().manager, input);
    await expect(runCreate(manager().manager, input)).rejects.toBeInstanceOf(ProjectStateError);
  });

  test("runs npm install, uv sync, and git init after scaffolding", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    await runCreate(subject, {
      name: "example",
      scaffoldRuntimeInput: HELLO_WORLD_PYTHON,
    });

    const projectRoot = join(directory, "example");
    expect(commands).toEqual([
      { command: ["npm", "install"], cwd: join(projectRoot, "agentcore", "cdk") },
      { command: ["uv", "sync"], cwd: join(projectRoot, "app", "hello_world") },
      { command: ["git", "init"], cwd: projectRoot },
    ]);
  });

  test("skipInstall skips npm install and uv sync", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    await runCreate(subject, {
      name: "example",
      scaffoldRuntimeInput: HELLO_WORLD_PYTHON,
      skipInstall: true,
    });

    expect(commands).toEqual([{ command: ["git", "init"], cwd: join(directory, "example") }]);
  });

  test("skipGit skips git init", async () => {
    await inTempDirectory();
    const { manager: subject, commands } = manager();
    await runCreate(subject, {
      name: "example",
      scaffoldRuntimeInput: HELLO_WORLD_PYTHON,
      skipGit: true,
    });

    expect(commands.map(({ command }) => command[0])).toEqual(["npm", "uv"]);
  });

  test("yields each step as a project event", async () => {
    await inTempDirectory();
    const { events, project } = await runCreate(manager().manager, {
      name: "example",
      scaffoldRuntimeInput: HELLO_WORLD_PYTHON,
    });

    expect(events.map((event) => event.message)).toEqual([
      "Creating project tree",
      "Installing CDK dependencies with npm",
      "Syncing Python dependencies with uv",
      "Initializing git repository",
    ]);
    expect(project.name).toBe("example");
    expect(project.rootPath).toContain("example");
    expect(project.spec.runtimes).toHaveLength(1);
  });

  test("a failed step propagates and leaves the scaffolded files in place", async () => {
    const directory = await inTempDirectory();
    const failing = new FsProjectManager({
      logger: createSilentLogger(),
      runner: async () => {
        throw new Error("npm exploded");
      },
      checkTool: async () => {},
    });

    await expect(
      runCreate(failing, { name: "example", scaffoldRuntimeInput: HELLO_WORLD_PYTHON }),
    ).rejects.toThrow("npm exploded");
    expect(await Bun.file(join(directory, "example", "agentcore", "agentcore.json")).exists()).toBe(
      true,
    );
  });

  test("refuses to create a project inside an existing project", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "root",
      scaffoldRuntimeInput: HELLO_WORLD_PYTHON,
    });

    process.chdir(join(directory, "root"));
    await expect(
      runCreate(manager().manager, {
        name: "child",
        scaffoldRuntimeInput: HELLO_WORLD_PYTHON,
      }),
    ).rejects.toBeInstanceOf(ProjectStateError);
  });
});

describe("FsProjectManager.build", () => {
  // build() requires the CDK app's node_modules; create() with skipInstall
  // never produces them, so tests stub the directory in.
  async function scaffolded(
    subject: FsProjectManager,
    directory: string,
    withDependencies = true,
  ): Promise<Project> {
    const { project } = await runCreate(subject, {
      name: "example",
      scaffoldRuntimeInput: HELLO_WORLD_PYTHON,
      skipInstall: true,
      skipGit: true,
    });
    if (withDependencies) {
      await mkdir(join(directory, "example", "agentcore", "cdk", "node_modules"), {
        recursive: true,
      });
    }
    return project;
  }

  async function drain(generator: AsyncGenerator<ProjectEvent, void>): Promise<ProjectEvent[]> {
    const events: ProjectEvent[] = [];
    for await (const event of generator) events.push(event);
    return events;
  }

  test("compiles and synthesizes via the generated cdk script", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    const project = await scaffolded(subject, directory);
    commands.length = 0; // discard create()'s commands

    const events = await drain(subject.build(project));

    expect(commands).toEqual([
      {
        command: [
          "npm",
          "run",
          "cdk",
          "--",
          "synth",
          "--quiet",
          "--output",
          join(directory, "example", "agentcore", "cdk", "cdk.out"),
        ],
        cwd: join(directory, "example", "agentcore", "cdk"),
      },
    ]);
    expect(events).toEqual([{ message: "Synthesizing CloudFormation templates" }]);
  });

  test("fails actionably when the CDK dependencies are missing", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    const project = await scaffolded(subject, directory, false);
    commands.length = 0;

    await expect(drain(subject.build(project))).rejects.toThrow(/npm install/);
    expect(commands).toEqual([]);
  });

  test("refuses a project managed by a backend it cannot build", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    const project = await scaffolded(subject, directory);
    commands.length = 0;

    // CDK is the only backend today; the cast stands in for a future one.
    const foreign = {
      ...project,
      spec: { ...project.spec, managedBy: "Terraform" as Project["spec"]["managedBy"] },
    };
    await expect(drain(subject.build(foreign))).rejects.toThrow(/unsupported backend: Terraform/);
    expect(commands).toEqual([]);
  });

  test("propagates a synthesis failure", async () => {
    const directory = await inTempDirectory();
    const { manager: subject } = manager();
    const project = await scaffolded(subject, directory);
    const failing = new FsProjectManager({
      logger: createSilentLogger(),
      runner: async () => {
        throw new Error("cdk synth exploded");
      },
      checkTool: async () => {},
    });

    await expect(drain(failing.build(project))).rejects.toThrow("cdk synth exploded");
  });
});

describe("FsProjectManager.deploy", () => {
  type DeployCall = { project: Project; input: DeployBackendInput };

  function deployManager() {
    const calls: DeployCall[] = [];
    const backend: ProjectBackend = {
      async *build() {},
      async *deploy(project, input) {
        calls.push({ project, input });
        yield { message: "Backend deployment started" };
        return { outputs: { RuntimeArn: "arn:runtime" } };
      },
    };
    return {
      calls,
      manager: new FsProjectManager({
        logger: createSilentLogger(),
        backends: { CDK: backend },
      }),
    };
  }

  async function projectWithTargets(rootPath: string, targets?: unknown): Promise<Project> {
    await mkdir(join(rootPath, "agentcore"), { recursive: true });
    if (targets !== undefined) {
      await writeFile(
        join(rootPath, "agentcore", "aws-targets.json"),
        typeof targets === "string" ? targets : JSON.stringify(targets),
      );
    }
    return {
      name: "example",
      rootPath,
      spec: {
        ...ProjectSpecSchema.parse({ name: "example", version: 1 }),
      },
    };
  }

  async function deploy(
    manager: FsProjectManager,
    project: Project,
    target: string,
    confirmTeardown: TeardownConfirmationHandler = async () => false,
  ): Promise<{ events: ProjectEvent[]; result: DeployResult }> {
    const generator = manager.deploy(project, {
      target,
      confirmTeardown,
    });
    const events: ProjectEvent[] = [];
    while (true) {
      const next = await generator.next();
      if (next.done) return { events, result: next.value };
      events.push(next.value as ProjectEvent);
    }
  }

  const targets: AwsDeploymentTarget[] = [
    {
      name: "staging",
      account: "111122223333",
      region: "us-east-1",
    },
    {
      name: "prod",
      account: "444455556666",
      region: "eu-west-1",
    },
  ];

  test("resolves one target and returns the backend result", async () => {
    const root = await inTempDirectory();
    const subject = deployManager();
    const project = await projectWithTargets(root, targets);

    const deployed = await deploy(subject.manager, project, "prod");

    expect(subject.calls).toHaveLength(1);
    expect(subject.calls[0]?.project).toBe(project);
    expect(subject.calls[0]?.input.target).toEqual(targets[1]);
    expect(deployed.events).toEqual([{ message: "Backend deployment started" }]);
    expect(deployed.result).toEqual({
      outputs: { RuntimeArn: "arn:runtime" },
    });
  });

  test("rejects an unknown target before invoking the backend", async () => {
    const root = await inTempDirectory();
    const subject = deployManager();
    const project = await projectWithTargets(root, targets);

    await expect(deploy(subject.manager, project, "prd")).rejects.toThrow(
      /no deployment target named 'prd'.*staging, prod/s,
    );
    expect(subject.calls).toEqual([]);
  });

  test.each([
    ["a missing file", undefined],
    ["an empty list", []],
  ])("rejects %s before invoking the backend", async (_label, configured) => {
    const root = await inTempDirectory();
    const subject = deployManager();
    const project = await projectWithTargets(root, configured);

    await expect(deploy(subject.manager, project, "default")).rejects.toThrow(
      /No deployment targets are configured/,
    );
    expect(subject.calls).toEqual([]);
  });

  test.each([
    ["malformed JSON", "{ not-json"],
    ["an invalid target", [{ name: "default", account: "not-an-account", region: "us-east-1" }]],
    [
      "duplicate targets",
      [
        {
          name: "default",
          account: "111122223333",
          region: "us-east-1",
        },
        {
          name: "default",
          account: "444455556666",
          region: "eu-west-1",
        },
      ],
    ],
  ])("rejects %s before invoking the backend", async (_label, configured) => {
    const root = await inTempDirectory();
    const subject = deployManager();
    const project = await projectWithTargets(root, configured);

    await expect(deploy(subject.manager, project, "default")).rejects.toBeInstanceOf(
      DeserializationError,
    );
    expect(subject.calls).toEqual([]);
  });
});

describe("FsProjectManager.resolve", () => {
  test("round-trips a project it just created", async () => {
    const root = await inTempDirectory();
    const subject = manager().manager;
    await runCreate(subject, {
      name: "example",
      scaffoldRuntimeInput: HELLO_WORLD_PYTHON,
    });

    // Resolve from a nested path to prove the walk-up to the project root.
    const resolved = await subject.resolve({ filePath: join(root, "example", "app") });

    expect(resolved?.name).toBe("example");
    expect(resolved?.rootPath).toBe(join(root, "example"));
    expect(resolved?.spec.managedBy).toBe("CDK");
    expect(resolved?.spec.runtimes).toHaveLength(1);
  });

  test("returns undefined when no project encloses the path", async () => {
    const root = await inTempDirectory();
    expect(await manager().manager.resolve({ filePath: root })).toBeUndefined();
  });

  test("throws on a malformed agentcore.json", async () => {
    const root = await inTempDirectory();
    await mkdir(join(root, "agentcore"), { recursive: true });
    await writeFile(join(root, "agentcore", "agentcore.json"), "{ not valid json");

    await expect(manager().manager.resolve({ filePath: root })).rejects.toBeInstanceOf(
      DeserializationError,
    );
  });

  test("names the offending field when the spec fails validation", async () => {
    const root = await inTempDirectory();
    await mkdir(join(root, "agentcore"), { recursive: true });
    // Valid JSON, invalid spec: a CodeZip runtime with no runtimeVersion.
    await writeFile(
      join(root, "agentcore", "agentcore.json"),
      JSON.stringify({
        name: "example",
        version: 1,
        runtimes: [
          {
            name: "hello_world",
            build: "CodeZip",
            entrypoint: "main.py",
            codeLocation: "app/hello_world",
          },
        ],
      }),
    );

    await expect(manager().manager.resolve({ filePath: root })).rejects.toThrow(
      "runtimeVersion is required for CodeZip builds",
    );
  });
});
