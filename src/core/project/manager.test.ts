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
import type { BackendDeployInput, ProjectBackend } from "./backends/types";

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

type RecordedDeploy = { project: Project; input: BackendDeployInput };

// A manager whose backend records what it is handed instead of building anything, so
// these tests cover only the part of build and deploy that is not a tool's business.
function delegating(): {
  manager: FsProjectManager;
  builds: Project[];
  deploys: RecordedDeploy[];
} {
  const builds: Project[] = [];
  const deploys: RecordedDeploy[] = [];
  const backend: ProjectBackend = {
    // eslint-disable-next-line require-yield
    build: async function* (project) {
      builds.push(project);
    },
    // eslint-disable-next-line require-yield
    deploy: async function* (project, input) {
      deploys.push({ project, input });
    },
  };
  return {
    manager: new FsProjectManager({
      logger: createSilentLogger(),
      runner: async () => {},
      checkTool: async () => {},
      backends: { CDK: backend },
    }),
    builds,
    deploys,
  };
}

const TARGET = { name: "default", account: "111122223333", region: "us-east-1" };

// Only what the manager itself reads: a project, and the target list beside it. A string
// is written verbatim so a test can supply invalid JSON, and null writes no file at all.
async function withTargets(root: string, targets: unknown = [TARGET]): Promise<Project> {
  await mkdir(join(root, "agentcore"), { recursive: true });
  if (targets !== null) {
    await writeFile(
      join(root, "agentcore", "aws-targets.json"),
      typeof targets === "string" ? targets : JSON.stringify(targets),
    );
  }
  return { name: "example", rootPath: root, managedBy: "CDK", runtimes: [] };
}

async function drain(generator: AsyncGenerator<ProjectEvent, void>): Promise<ProjectEvent[]> {
  const events: ProjectEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
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
  test("hands the project to the backend that owns its artifacts", async () => {
    const root = await inTempDirectory();
    const { manager: subject, builds } = delegating();
    const project = await withTargets(root);

    await drain(subject.build(project));

    expect(builds).toEqual([project]);
  });

  test("refuses a project managed by a backend it has none for", async () => {
    const root = await inTempDirectory();
    const { manager: subject, builds } = delegating();
    const project = await withTargets(root);

    // CDK is the only backend today; the cast stands in for a future one.
    const foreign = { ...project, managedBy: "Terraform" as Project["managedBy"] };
    await expect(drain(subject.build(foreign))).rejects.toThrow(/unsupported backend: Terraform/);
    expect(builds).toEqual([]);
  });
});

describe("FsProjectManager.deploy", () => {
  // The region the backend's own tooling makes its calls in, which is not a target's.
  const REGION = "us-west-2";

  // The three-target project the target-selection tests share. 'default' is last, so
  // selecting it cannot be an artifact of the order the list happens to be in.
  const PROD = { name: "prod", account: "444455556666", region: "eu-west-1" };
  const DEFAULT = { name: "default", account: "777788889999", region: "us-west-2" };
  const TARGETS = [
    { name: "staging", account: "111122223333", region: "us-east-1" },
    PROD,
    DEFAULT,
  ];

  test("hands the backend the requested target, and the region to call in", async () => {
    const root = await inTempDirectory();
    const { manager: subject, deploys } = delegating();
    const project = await withTargets(root);

    await drain(subject.deploy(project, { region: REGION, target: "default" }));

    expect(deploys).toEqual([{ project, input: { target: TARGET, region: REGION } }]);
  });

  test("deploys only the requested target", async () => {
    const root = await inTempDirectory();
    const { manager: subject, deploys } = delegating();
    const project = await withTargets(root, TARGETS);

    await drain(subject.deploy(project, { region: REGION, target: "prod" }));

    // A project with a staging and a prod target cannot reach the others by accident:
    // one deploy ships one target.
    expect(deploys.map(({ input }) => input.target)).toEqual([PROD]);
  });

  test("deploys the target named 'default' when none is requested", async () => {
    const root = await inTempDirectory();
    const { manager: subject, deploys } = delegating();
    const project = await withTargets(root, TARGETS);

    // What the handler passes when --target is omitted, and the name the example in
    // the empty-targets error uses.
    await drain(subject.deploy(project, { region: REGION, target: "default" }));

    expect(deploys.map(({ input }) => input.target)).toEqual([DEFAULT]);
  });

  test("names the configured targets when the requested one is not among them", async () => {
    const root = await inTempDirectory();
    const { manager: subject, deploys } = delegating();
    const project = await withTargets(root, TARGETS);

    await expect(drain(subject.deploy(project, { region: REGION, target: "prd" }))).rejects.toThrow(
      /no deployment target named 'prd'.*staging, prod, default/s,
    );
    // Resolved before the backend runs, so a misspelled --target costs no build.
    expect(deploys).toEqual([]);
  });

  test("names the file to fix when no deployment targets are configured", async () => {
    const root = await inTempDirectory();
    const { manager: subject, deploys } = delegating();

    // The empty list create() scaffolds, and a project with no list at all: both are a
    // deploy with nowhere to go, and neither reaches the backend.
    for (const targets of [[], null]) {
      const project = await withTargets(root, targets);
      await expect(
        drain(subject.deploy(project, { region: REGION, target: "default" })),
      ).rejects.toThrow(/aws-targets\.json/);
      await rm(join(root, "agentcore", "aws-targets.json"), { force: true });
    }
    expect(deploys).toEqual([]);
  });

  test("reports a malformed aws-targets.json as an actionable error", async () => {
    const root = await inTempDirectory();
    const { manager: subject } = delegating();
    const project = await withTargets(root, "{ not a target list");

    await expect(
      drain(subject.deploy(project, { region: REGION, target: "default" })),
    ).rejects.toThrow(/is not a valid list of deployment targets/);
  });

  test("rejects targets that omit a required field", async () => {
    const root = await inTempDirectory();
    const { manager: subject } = delegating();
    const project = await withTargets(root, [{ name: "default", region: "us-east-1" }]);

    await expect(
      drain(subject.deploy(project, { region: REGION, target: "default" })),
    ).rejects.toThrow(/is not a valid list of deployment targets/);
  });

  test("refuses a project managed by a backend it has none for", async () => {
    const root = await inTempDirectory();
    const { manager: subject, deploys } = delegating();
    const project = await withTargets(root);

    // CDK is the only backend today; the cast stands in for a future one.
    const foreign = { ...project, managedBy: "Terraform" as Project["managedBy"] };
    await expect(
      drain(subject.deploy(foreign, { region: REGION, target: "default" })),
    ).rejects.toThrow(/unsupported backend: Terraform/);
    expect(deploys).toEqual([]);
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
