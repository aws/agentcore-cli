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
import { createRecordingLogger, createSilentLogger, type RecordedLog } from "../../testing";
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
    expect(events).toEqual([{ kind: "step", message: "Synthesizing CloudFormation templates" }]);
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
  ): {
    manager: FsProjectManager;
    commands: RecordedCommand[];
    runs: RecordedCdkRun[];
    logs: RecordedLog[];
  } {
    const commands: RecordedCommand[] = [];
    const runs: RecordedCdkRun[] = [];
    const { logger, logs } = createRecordingLogger();
    return {
      manager: new FsProjectManager({
        logger,
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
      logs,
    };
  }

  // The assembly directory every operation reads, which build synthesized into.
  function assemblyDirectory(directory: string): string {
    return join(directory, "example", "agentcore", "cdk", "cdk.out");
  }

  // How the generated CDK app names the stack it synthesizes for a target.
  function stackName(target: string): string {
    return `AgentCore-example-${target}`;
  }

  // Stands in for what synth leaves behind: a manifest with one stack per target,
  // each tagged with the target it belongs to. deploy reads it to find the stack to
  // ship, and the stubbed runner never writes one.
  async function synthesized(directory: string, targetNames: string[]): Promise<void> {
    const assembly = assemblyDirectory(directory);
    await mkdir(assembly, { recursive: true });
    await writeFile(
      join(assembly, "manifest.json"),
      JSON.stringify({
        version: "36.0.0",
        artifacts: {
          // A non-stack artifact, as a real assembly has: only stacks are candidates.
          Tree: { type: "cdk:tree" },
          ...Object.fromEntries(
            targetNames.map((target) => [
              stackName(target),
              {
                type: "aws:cloudformation:stack",
                properties: { tags: { "agentcore:target-name": target } },
              },
            ]),
          ),
        },
      }),
    );
  }

  // deploy() builds first, so the CDK app's node_modules must exist; create() with
  // skipInstall never produces them. Targets overwrite the empty list create()
  // scaffolds; null leaves that empty list in place, and a string is written verbatim
  // so a test can supply invalid JSON. A well-formed list also gets the assembly
  // synth would have produced for it.
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
    if (Array.isArray(targets)) {
      await synthesized(
        directory,
        (targets as { name?: string }[]).flatMap(({ name }) => (name ? [name] : [])),
      );
    }
    return project;
  }

  async function drain(generator: AsyncGenerator<ProjectEvent, void>): Promise<ProjectEvent[]> {
    const events: ProjectEvent[] = [];
    for await (const event of generator) events.push(event);
    return events;
  }

  // The toolkit's own messages, as they landed in the log: tagged with the operation
  // that reported them, unlike the manager's own lines.
  function logged(logs: RecordedLog[]): { level: string; message: string }[] {
    return logs
      .filter((line) => line.bindings.cdk !== undefined)
      .map(({ level, message }) => ({ level, message }));
  }

  test("synthesizes, bootstraps the target environment, then deploys its stack", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands, runs } = deployManager();
    const project = await scaffolded(subject, directory);
    commands.length = 0; // discard create()'s commands
    const cdkDir = join(directory, "example", "agentcore", "cdk");
    const options = { assemblyDirectory: assemblyDirectory(directory), region: REGION };

    const events = await drain(
      subject.deploy(project, { region: REGION, skipBootstrap: false, target: "default" }),
    );

    // Only synthesis shells out; everything that reaches AWS goes through the toolkit.
    expect(commands).toEqual([{ command: synthCommand(directory), cwd: cdkDir }]);
    expect(runs).toEqual([
      { operation: { kind: "bootstrap", environments: ["aws://111122223333/us-east-1"] }, options },
      { operation: { kind: "deploy", stackName: stackName("default") }, options },
    ]);
    expect(events).toEqual([
      { kind: "step", message: "Synthesizing CloudFormation templates" },
      { kind: "step", message: "Bootstrapping aws://111122223333/us-east-1" },
      { kind: "step", message: `Deploying ${stackName("default")}` },
    ]);
  });

  test("synthesizes into the same directory the toolkit deploys from", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands, runs } = deployManager();
    const project = await scaffolded(subject, directory);
    commands.length = 0;

    await drain(
      subject.deploy(project, { region: REGION, skipBootstrap: true, target: "default" }),
    );

    // The invariant behind passing --output at all: whatever synth was told to write
    // is exactly what the toolkit is handed. Left to cdk.json's `output`, synth could
    // write elsewhere and deploy would ship a stale assembly while reporting success.
    const assembly = assemblyDirectory(directory);
    expect(commands[0]?.command.at(-1)).toBe(assembly);
    expect(runs.map(({ options }) => options.assemblyDirectory)).toEqual([assembly]);
  });

  // The three-target project the target-selection tests share.
  const TARGETS = [
    { name: "staging", account: "111122223333", region: "us-east-1" },
    { name: "prod", account: "444455556666", region: "eu-west-1" },
    { name: "default", account: "777788889999", region: "us-west-2" },
  ];

  test("deploys only the requested target's stack, into only its environment", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, runs } = deployManager();
    const project = await scaffolded(subject, directory, TARGETS);

    await drain(subject.deploy(project, { region: REGION, skipBootstrap: false, target: "prod" }));

    // A project with a staging and a prod target cannot reach the others by
    // accident: one deploy bootstraps one environment and ships one stack.
    expect(runs.map(({ operation }) => operation)).toEqual([
      { kind: "bootstrap", environments: ["aws://444455556666/eu-west-1"] },
      { kind: "deploy", stackName: stackName("prod") },
    ]);
  });

  test("deploys the target named 'default' when none is requested", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, runs } = deployManager();
    const project = await scaffolded(subject, directory, TARGETS);

    // What the handler passes when --target is omitted, and the name the example in
    // the empty-targets error uses.
    await drain(
      subject.deploy(project, { region: REGION, skipBootstrap: true, target: "default" }),
    );

    expect(runs.map(({ operation }) => operation)).toEqual([
      { kind: "deploy", stackName: stackName("default") },
    ]);
  });

  test("names the configured targets when the requested one is not among them", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands, runs } = deployManager();
    const project = await scaffolded(subject, directory, TARGETS);
    commands.length = 0;

    await expect(
      drain(subject.deploy(project, { region: REGION, skipBootstrap: false, target: "prd" })),
    ).rejects.toThrow(/no deployment target named 'prd'.*staging, prod, default/s);
    // Resolved before synthesizing, so a misspelled --target costs no build.
    expect(commands).toEqual([]);
    expect(runs).toEqual([]);
  });

  test("fails when the synthesized assembly has no stack for the target", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, runs } = deployManager();
    const project = await scaffolded(subject, directory);
    // An assembly synthesized from a different target list than the one on disk —
    // what a hand-edited CDK app that stops tagging its stacks would leave behind.
    await synthesized(directory, ["other"]);

    await expect(
      drain(subject.deploy(project, { region: REGION, skipBootstrap: false, target: "default" })),
    ).rejects.toThrow(/no stack for deployment target 'default'/);
    // Resolved before bootstrapping, so nothing reached AWS.
    expect(runs).toEqual([]);
  });

  test("names the path it looked in when synthesis wrote no assembly", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, runs } = deployManager();
    const project = await scaffolded(subject, directory);
    // Synthesis is stubbed in these tests, so removing the stand-in manifest is what
    // a real synth writing somewhere else entirely would leave behind.
    await rm(join(assemblyDirectory(directory), "manifest.json"));

    await expect(
      drain(subject.deploy(project, { region: REGION, skipBootstrap: false, target: "default" })),
    ).rejects.toThrow(/No synthesized cloud assembly was found at .*manifest\.json/);
    expect(runs).toEqual([]);
  });

  test("skips bootstrapping when asked, and still deploys", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands, runs } = deployManager();
    const project = await scaffolded(subject, directory);
    commands.length = 0;
    const cdkDir = join(directory, "example", "agentcore", "cdk");

    const events = await drain(
      subject.deploy(project, { region: REGION, skipBootstrap: true, target: "default" }),
    );

    expect(commands).toEqual([{ command: synthCommand(directory), cwd: cdkDir }]);
    expect(runs.map(({ operation }) => operation)).toEqual([
      { kind: "deploy", stackName: stackName("default") },
    ]);
    expect(events).not.toContainEqual({
      kind: "step",
      message: "Bootstrapping aws://111122223333/us-east-1",
    });
  });

  test("names the file to fix when no deployment targets are configured", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands, runs } = deployManager();
    // create() scaffolds an empty list, which is what a fresh project has.
    const project = await scaffolded(subject, directory, null);
    commands.length = 0;

    await expect(
      drain(subject.deploy(project, { region: REGION, skipBootstrap: false, target: "default" })),
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
      drain(subject.deploy(project, { region: REGION, skipBootstrap: false, target: "default" })),
    ).rejects.toThrow(/is not a valid list of deployment targets/);
  });

  test("rejects targets that omit a required field", async () => {
    const directory = await inTempDirectory();
    const { manager: subject } = deployManager();
    const project = await scaffolded(subject, directory, [
      { name: "default", region: "us-east-1" },
    ]);

    await expect(
      drain(subject.deploy(project, { region: REGION, skipBootstrap: false, target: "default" })),
    ).rejects.toThrow(/is not a valid list of deployment targets/);
  });

  test("logs the toolkit's messages instead of reporting them as events", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, logs } = deployManager((operation, emit) => {
      if (operation.kind !== "deploy") return;
      emit({ level: "info", message: "example-stack: creating CloudFormation changeset..." });
      emit({ level: "result", message: "example-stack: deployed" });
    });
    const project = await scaffolded(subject, directory);

    const events = await drain(
      subject.deploy(project, { region: REGION, skipBootstrap: true, target: "default" }),
    );

    // A deploy reports its own steps and nothing the toolkit said, so what reaches
    // the screen stays the same length however talkative a deploy turns out to be.
    expect(events).toEqual([
      { kind: "step", message: "Synthesizing CloudFormation templates" },
      { kind: "step", message: `Deploying ${stackName("default")}` },
    ]);
    // `result` reports an outcome rather than a severity, so it lands as info.
    expect(logged(logs)).toEqual([
      { level: "info", message: "example-stack: creating CloudFormation changeset..." },
      { level: "info", message: "example-stack: deployed" },
    ]);
  });

  test("logs each toolkit message at the severity the toolkit gave it", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, logs } = deployManager((operation, emit) => {
      if (operation.kind !== "deploy") return;
      emit({ level: "debug", message: "resolved 3 environments" });
      emit({ level: "trace", message: "sdk call: DescribeStacks" });
      emit({ level: "warn", message: "example-stack: no changes" });
      emit({ level: "error", message: "example-stack: UPDATE_ROLLBACK_COMPLETE" });
    });
    const project = await scaffolded(subject, directory);

    await drain(
      subject.deploy(project, { region: REGION, skipBootstrap: true, target: "default" }),
    );

    // Severity is what makes the log readable once a deploy has written thousands of
    // lines to it: a failure is greppable rather than buried among the trace, which
    // is finer than any level this CLI logs at and so joins debug.
    expect(logged(logs)).toEqual([
      { level: "debug", message: "resolved 3 environments" },
      { level: "debug", message: "sdk call: DescribeStacks" },
      { level: "warn", message: "example-stack: no changes" },
      { level: "error", message: "example-stack: UPDATE_ROLLBACK_COMPLETE" },
    ]);
  });

  test("logs the output that explains a failure before propagating it", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, logs } = deployManager((operation, emit) => {
      if (operation.kind !== "deploy") return;
      emit({ level: "error", message: "example-stack: CREATE_FAILED" });
      throw new Error("cdk deploy exploded");
    });
    const project = await scaffolded(subject, directory);

    await expect(
      drain(subject.deploy(project, { region: REGION, skipBootstrap: true, target: "default" })),
    ).rejects.toThrow("cdk deploy exploded");

    // The failure reaches the caller, but only the log says what went wrong, which is
    // why deploy prints where the log is.
    expect(logged(logs)).toContainEqual({
      level: "error",
      message: "example-stack: CREATE_FAILED",
    });
  });

  test("refuses a project managed by a backend it cannot deploy", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands, runs } = deployManager();
    const project = await scaffolded(subject, directory);
    commands.length = 0;

    // CDK is the only backend today; the cast stands in for a future one.
    const foreign = { ...project, managedBy: "Terraform" as Project["managedBy"] };
    await expect(
      drain(subject.deploy(foreign, { region: REGION, skipBootstrap: false, target: "default" })),
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
      drain(subject.deploy(project, { region: REGION, skipBootstrap: false, target: "default" })),
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
