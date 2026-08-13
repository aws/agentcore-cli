import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { InputValidationError, ProjectStateError } from "../../errors/errors";
import { FsProjectManager } from "./manager";
import {
  PROJECT_TEMPLATES,
  type CreateProjectInput,
  type Project,
  type ProjectEvent,
} from "../../handlers/project/types";
import { createSilentLogger } from "../../testing";
import type { CdkEvent, CdkOperation, CdkRunOptions } from "../../io";

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

describe("FsProjectManager.create", () => {
  test("scaffolds the expected file tree into a fresh directory", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "example",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
    });

    const projectRoot = join(directory, "example");
    const manifest = (await readdir(projectRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) =>
        relative(projectRoot, join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
      )
      .sort();

    expect(manifest).toMatchSnapshot();
  });

  test("writes a deploy-ready agentcore.json registering the template agent", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "example",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
    });

    const configDir = join(directory, "example", "agentcore");
    const spec = await Bun.file(join(configDir, "agentcore.json")).json();
    expect(spec.name).toBe("example");
    expect(spec.runtimes).toEqual([
      {
        name: "hello_world",
        build: "CodeZip",
        entrypoint: "main.py",
        codeLocation: "app/hello-world",
        runtimeVersion: "PYTHON_3_14",
      },
    ]);
    expect(await Bun.file(join(configDir, "aws-targets.json")).json()).toEqual([]);
  });

  test("scaffolds the container template with a Dockerfile and .dockerignore", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "example",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON_CONTAINER,
    });

    const appDir = join(directory, "example", "app", "hello-world");
    // dockerignore.template must render to .dockerignore (the fsTree regex fix).
    expect(await Bun.file(join(appDir, ".dockerignore")).exists()).toBe(true);
    expect(await Bun.file(join(appDir, "dockerignore.template")).exists()).toBe(false);
    expect(await Bun.file(join(appDir, "Dockerfile")).exists()).toBe(true);

    const spec = await Bun.file(join(directory, "example", "agentcore", "agentcore.json")).json();
    expect(spec.runtimes[0]).toMatchObject({ build: "Container", dockerfile: "Dockerfile" });
  });

  test("refuses to overwrite an existing project", async () => {
    await inTempDirectory();
    const input = { name: "example", template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON };

    await runCreate(manager().manager, input);
    await expect(runCreate(manager().manager, input)).rejects.toBeInstanceOf(ProjectStateError);
  });

  test("runs npm install, uv sync, and git init after scaffolding", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    await runCreate(subject, { name: "example", template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON });

    const projectRoot = join(directory, "example");
    expect(commands).toEqual([
      { command: ["npm", "install"], cwd: join(projectRoot, "agentcore", "cdk") },
      { command: ["uv", "sync"], cwd: join(projectRoot, "app", "hello-world") },
      { command: ["git", "init"], cwd: projectRoot },
    ]);
  });

  test("skipInstall skips npm install and uv sync", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    await runCreate(subject, {
      name: "example",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
      skipInstall: true,
    });

    expect(commands).toEqual([{ command: ["git", "init"], cwd: join(directory, "example") }]);
  });

  test("skipGit skips git init", async () => {
    await inTempDirectory();
    const { manager: subject, commands } = manager();
    await runCreate(subject, {
      name: "example",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
      skipGit: true,
    });

    expect(commands.map(({ command }) => command[0])).toEqual(["npm", "uv"]);
  });

  test("yields each step as a project event", async () => {
    await inTempDirectory();
    const { events, project } = await runCreate(manager().manager, {
      name: "example",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
    });

    expect(events.map((event) => event.message)).toEqual([
      "Creating project tree",
      "Installing CDK dependencies with npm",
      "Syncing Python dependencies with uv",
      "Initializing git repository",
    ]);
    expect(project.name).toBe("example");
    expect(project.rootPath).toContain("example");
    expect(project.runtimes).toHaveLength(1);
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
      runCreate(failing, { name: "example", template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON }),
    ).rejects.toThrow("npm exploded");
    expect(await Bun.file(join(directory, "example", "agentcore", "agentcore.json")).exists()).toBe(
      true,
    );
  });

  test("refuses to create a project inside an existing project", async () => {
    const directory = await inTempDirectory();
    await runCreate(manager().manager, {
      name: "root",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
    });

    process.chdir(join(directory, "root"));
    await expect(
      runCreate(manager().manager, {
        name: "child",
        template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
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
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
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

    const cdkDir = join(directory, "example", "agentcore", "cdk");
    expect(commands).toEqual([
      {
        // --output pins the assembly where deploy looks for it, so a project that
        // sets cdk.json's `output` cannot send synth somewhere deploy never reads.
        command: [
          "npm",
          "run",
          "cdk",
          "--",
          "synth",
          "--quiet",
          "--output",
          join(cdkDir, "cdk.out"),
        ],
        cwd: cdkDir,
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
    const foreign = { ...project, managedBy: "Terraform" as Project["managedBy"] };
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
  // Synth is pinned to the directory deploy reads, so both name it the same way.
  function synthCommand(directory: string): string[] {
    return [
      "npm",
      "run",
      "cdk",
      "--",
      "synth",
      "--quiet",
      "--output",
      assemblyDirectory(directory),
    ];
  }
  const REGION = "us-west-2";

  type RecordedCommand = { command: string[]; cwd: string };
  type RecordedCdkRun = { operation: CdkOperation; options: CdkRunOptions };

  // Like manager(), but also records the CDK operations the manager drives, and lets
  // a test supply the events one of them emits (and the failure it ends with).
  function deployManager(
    onCdk?: (operation: CdkOperation, emit: (event: CdkEvent) => void) => void,
  ): { manager: FsProjectManager; commands: RecordedCommand[]; runs: RecordedCdkRun[] } {
    const commands: RecordedCommand[] = [];
    const runs: RecordedCdkRun[] = [];
    return {
      manager: new FsProjectManager({
        logger: createSilentLogger(),
        runner: async (command, { cwd }) => {
          commands.push({ command, cwd });
        },
        cdk: async function* (operation, options) {
          runs.push({ operation, options });
          const events: CdkEvent[] = [];
          let failure: unknown;
          try {
            onCdk?.(operation, (event) => events.push(event));
          } catch (error) {
            failure = error;
          }
          // Emit before throwing, as the real runner does: the output explaining a
          // failure is only useful if the consumer sees it.
          yield* events;
          if (failure) throw failure;
        },
        checkTool: async () => {},
      }),
      commands,
      runs,
    };
  }

  // The assembly directory every operation reads, which build synthesized into.
  function assemblyDirectory(directory: string): string {
    return join(directory, "example", "agentcore", "cdk", "cdk.out");
  }

  // deploy() builds first, so the CDK app's node_modules must exist; create() with
  // skipInstall never produces them. Targets overwrite the empty list create()
  // scaffolds; null leaves that empty list in place, and a string is written verbatim
  // so a test can supply invalid JSON.
  async function scaffolded(
    subject: FsProjectManager,
    directory: string,
    targets: unknown = [{ name: "default", account: "111122223333", region: "us-east-1" }],
  ): Promise<Project> {
    const { project } = await runCreate(subject, {
      name: "example",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
      skipInstall: true,
      skipGit: true,
    });
    await mkdir(join(directory, "example", "agentcore", "cdk", "node_modules"), {
      recursive: true,
    });
    if (targets !== null) {
      await writeFile(
        join(directory, "example", "agentcore", "aws-targets.json"),
        typeof targets === "string" ? targets : JSON.stringify(targets),
      );
    }
    return project;
  }

  async function drain(generator: AsyncGenerator<ProjectEvent, void>): Promise<ProjectEvent[]> {
    const events: ProjectEvent[] = [];
    for await (const event of generator) events.push(event);
    return events;
  }

  test("synthesizes, bootstraps the target environment, then deploys every stack", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands, runs } = deployManager();
    const project = await scaffolded(subject, directory);
    commands.length = 0; // discard create()'s commands
    const cdkDir = join(directory, "example", "agentcore", "cdk");
    const options = { assemblyDirectory: assemblyDirectory(directory), region: REGION };

    const events = await drain(subject.deploy(project, { region: REGION, skipBootstrap: false }));

    // Only synthesis shells out; everything that reaches AWS goes through the toolkit.
    expect(commands).toEqual([{ command: synthCommand(directory), cwd: cdkDir }]);
    expect(runs).toEqual([
      { operation: { kind: "bootstrap", environments: ["aws://111122223333/us-east-1"] }, options },
      { operation: { kind: "deploy" }, options },
    ]);
    expect(events).toEqual([
      { message: "Synthesizing CloudFormation templates" },
      { message: "Bootstrapping aws://111122223333/us-east-1" },
      { message: "Deploying stacks" },
    ]);
  });

  test("synthesizes into the same directory the toolkit deploys from", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands, runs } = deployManager();
    const project = await scaffolded(subject, directory);
    commands.length = 0;

    await drain(subject.deploy(project, { region: REGION, skipBootstrap: true }));

    // The invariant behind passing --output at all: whatever synth was told to write
    // is exactly what the toolkit is handed. Left to cdk.json's `output`, synth could
    // write elsewhere and deploy would ship a stale assembly while reporting success.
    const assembly = assemblyDirectory(directory);
    expect(commands[0]?.command.at(-1)).toBe(assembly);
    expect(runs.map(({ options }) => options.assemblyDirectory)).toEqual([assembly]);
  });

  test("bootstraps each distinct environment once, however many targets share it", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, runs } = deployManager();
    const project = await scaffolded(subject, directory, [
      { name: "alpha", account: "111122223333", region: "us-east-1" },
      { name: "beta", account: "111122223333", region: "us-east-1" }, // same environment
      { name: "gamma", account: "444455556666", region: "eu-west-1" },
    ]);

    await drain(subject.deploy(project, { region: REGION, skipBootstrap: false }));

    expect(
      runs.flatMap(({ operation }) =>
        operation.kind === "bootstrap" ? operation.environments : [],
      ),
    ).toEqual(["aws://111122223333/us-east-1", "aws://444455556666/eu-west-1"]);
  });

  test("skips bootstrapping when asked, and still deploys", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands, runs } = deployManager();
    const project = await scaffolded(subject, directory);
    commands.length = 0;
    const cdkDir = join(directory, "example", "agentcore", "cdk");

    const events = await drain(subject.deploy(project, { region: REGION, skipBootstrap: true }));

    expect(commands).toEqual([{ command: synthCommand(directory), cwd: cdkDir }]);
    expect(runs.map(({ operation }) => operation)).toEqual([{ kind: "deploy" }]);
    expect(events).not.toContainEqual({ message: "Bootstrapping aws://111122223333/us-east-1" });
  });

  test("names the file to fix when no deployment targets are configured", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands, runs } = deployManager();
    // create() scaffolds an empty list, which is what a fresh project has.
    const project = await scaffolded(subject, directory, null);
    commands.length = 0;

    await expect(
      drain(subject.deploy(project, { region: REGION, skipBootstrap: false })),
    ).rejects.toThrow(/aws-targets\.json/);
    // Nothing ran at all: a deploy with nowhere to go does not even synthesize.
    expect(commands).toEqual([]);
    expect(runs).toEqual([]);
  });

  test("reports a malformed aws-targets.json as an actionable error", async () => {
    const directory = await inTempDirectory();
    const { manager: subject } = deployManager();
    const project = await scaffolded(subject, directory, "{ not a target list");

    await expect(
      drain(subject.deploy(project, { region: REGION, skipBootstrap: false })),
    ).rejects.toThrow(/is not a valid list of deployment targets/);
  });

  test("rejects targets that omit a required field", async () => {
    const directory = await inTempDirectory();
    const { manager: subject } = deployManager();
    const project = await scaffolded(subject, directory, [
      { name: "default", region: "us-east-1" },
    ]);

    await expect(
      drain(subject.deploy(project, { region: REGION, skipBootstrap: false })),
    ).rejects.toThrow(/is not a valid list of deployment targets/);
  });

  test("streams the CDK toolkit's messages as they arrive", async () => {
    const directory = await inTempDirectory();
    const { manager: subject } = deployManager((operation, emit) => {
      if (operation.kind !== "deploy") return;
      emit({ level: "info", message: "example-stack: creating CloudFormation changeset..." });
      emit({ level: "result", message: "example-stack: deployed" });
    });
    const project = await scaffolded(subject, directory);

    const events = await drain(subject.deploy(project, { region: REGION, skipBootstrap: true }));

    expect(events.map((event) => event.output).filter(Boolean)).toEqual([
      "example-stack: creating CloudFormation changeset...",
      "example-stack: deployed",
    ]);
  });

  test("keeps the toolkit's debug and trace messages off screen", async () => {
    const directory = await inTempDirectory();
    const { manager: subject } = deployManager((operation, emit) => {
      if (operation.kind !== "deploy") return;
      emit({ level: "debug", message: "resolved 3 environments" });
      emit({ level: "trace", message: "sdk call: DescribeStacks" });
      emit({ level: "warn", message: "example-stack: no changes" });
    });
    const project = await scaffolded(subject, directory);

    const events = await drain(subject.deploy(project, { region: REGION, skipBootstrap: true }));

    // The suppressed ones are still in the debug log; only the warning is surfaced.
    expect(events.map((event) => event.output).filter(Boolean)).toEqual([
      "example-stack: no changes",
    ]);
  });

  test("yields the output that explains a failure before propagating it", async () => {
    const directory = await inTempDirectory();
    const { manager: subject } = deployManager((operation, emit) => {
      if (operation.kind !== "deploy") return;
      emit({ level: "error", message: "example-stack: CREATE_FAILED" });
      throw new Error("cdk deploy exploded");
    });
    const project = await scaffolded(subject, directory);

    const events: ProjectEvent[] = [];
    const generator = subject.deploy(project, { region: REGION, skipBootstrap: true });
    await expect(
      (async () => {
        for await (const event of generator) events.push(event);
      })(),
    ).rejects.toThrow("cdk deploy exploded");
    expect(events).toContainEqual({ output: "example-stack: CREATE_FAILED" });
  });

  test("refuses a project managed by a backend it cannot deploy", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands, runs } = deployManager();
    const project = await scaffolded(subject, directory);
    commands.length = 0;

    // CDK is the only backend today; the cast stands in for a future one.
    const foreign = { ...project, managedBy: "Terraform" as Project["managedBy"] };
    await expect(
      drain(subject.deploy(foreign, { region: REGION, skipBootstrap: false })),
    ).rejects.toThrow(/unsupported backend: Terraform/);
    expect(commands).toEqual([]);
    expect(runs).toEqual([]);
  });

  test("fails before touching AWS when the CDK dependencies are missing", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands, runs } = deployManager();
    const project = await scaffolded(subject, directory);
    await rm(join(directory, "example", "agentcore", "cdk", "node_modules"), { recursive: true });
    commands.length = 0;

    await expect(
      drain(subject.deploy(project, { region: REGION, skipBootstrap: false })),
    ).rejects.toThrow(/npm install/);
    expect(commands).toEqual([]);
    expect(runs).toEqual([]);
  });
});

describe("FsProjectManager.resolve", () => {
  test("round-trips a project it just created", async () => {
    const root = await inTempDirectory();
    const subject = manager().manager;
    await runCreate(subject, { name: "example", template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON });

    // Resolve from a nested path to prove the walk-up to the project root.
    const resolved = await subject.resolve({ filePath: join(root, "example", "app") });

    expect(resolved?.name).toBe("example");
    expect(resolved?.rootPath).toBe(join(root, "example"));
    expect(resolved?.managedBy).toBe("CDK");
    expect(resolved?.runtimes).toHaveLength(1);
  });

  test("returns undefined when no project encloses the path", async () => {
    const root = await inTempDirectory();
    expect(await manager().manager.resolve({ filePath: root })).toBeUndefined();
  });

  test("throws InputValidationError on a malformed agentcore.json", async () => {
    const root = await inTempDirectory();
    await mkdir(join(root, "agentcore"), { recursive: true });
    await writeFile(join(root, "agentcore", "agentcore.json"), "{ not valid json");

    await expect(manager().manager.resolve({ filePath: root })).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });
});
