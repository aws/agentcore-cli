import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { ProjectStateError } from "../../errors/errors";
import { FsProjectManager } from "./manager";
import {
  PROJECT_TEMPLATES,
  type CreateProjectInput,
  type Project,
  type ProjectEvent,
} from "../../handlers/project/types";
import { createSilentLogger } from "../../testing";
import type { ProcessRunner } from "../../io";

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

// A manager whose runner records commands instead of spawning them and whose
// account detection resolves a fixed account instead of calling STS.
function manager(
  overrides: {
    runner?: ProcessRunner;
    resolveAccount?: (region: string) => Promise<string>;
  } = {},
): { manager: FsProjectManager; commands: { command: string[]; cwd: string }[] } {
  const commands: { command: string[]; cwd: string }[] = [];
  return {
    manager: new FsProjectManager({
      logger: createSilentLogger(),
      runner:
        overrides.runner ??
        (async (command, { cwd }) => {
          commands.push({ command, cwd });
        }),
      checkTool: async () => {}, // CI hosts don't have uv installed
      resolveAccount: overrides.resolveAccount ?? (async () => "123456789012"),
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
      return { events, project: next.value as Project };
    }
    events.push(next.value);
  }
}

// Drains a project generator (build/deploy), returning the events it yielded.
async function drain(generator: AsyncGenerator<ProjectEvent>): Promise<ProjectEvent[]> {
  const events: ProjectEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

// Scaffolds a bare project (no install, no git) and returns its root, so
// build/deploy tests start from a clean command recording.
async function scaffolded(subject: FsProjectManager, directory: string): Promise<string> {
  await runCreate(subject, {
    name: "example",
    template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
    skipInstall: true,
    skipGit: true,
  });
  return join(directory, "example");
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
    const directory = await inTempDirectory();
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
    expect(project).toEqual({ name: "example", root: join(directory, "example") });
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

describe("FsProjectManager.resolve", () => {
  test("locates the project from a nested path", async () => {
    const directory = await inTempDirectory();
    const subject = manager().manager;
    const root = await scaffolded(subject, directory);

    const project = await subject.resolve({ filePath: join(root, "app", "hello-world") });
    expect(project).toEqual({ name: "example", root });
  });

  test("returns undefined when no project encloses the path", async () => {
    const directory = await inTempDirectory();
    expect(await manager().manager.resolve({ filePath: directory })).toBeUndefined();
  });
});

describe("FsProjectManager.build", () => {
  test("compiles the CDK app and synthesizes in the vended cdk directory", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    const root = await scaffolded(subject, directory);

    const events = await drain(subject.build({ path: root, region: "us-east-2" }));

    const cdkDir = join(root, "agentcore", "cdk");
    expect(commands).toEqual([
      { command: ["npm", "run", "build"], cwd: cdkDir },
      { command: ["npx", "cdk", "synth"], cwd: cdkDir },
    ]);
    expect(events.map((event) => event.message).filter(Boolean)).toEqual([
      "Detecting the AWS account for a default deployment target",
      "Configured default deployment target aws://123456789012/us-east-2",
      "Compiling the CDK app",
      "Synthesizing CloudFormation templates with cdk synth",
    ]);
  });

  test("auto-populates an empty aws-targets.json with a default target", async () => {
    const directory = await inTempDirectory();
    const { manager: subject } = manager();
    const root = await scaffolded(subject, directory);

    await drain(subject.build({ path: root, region: "us-east-2" }));

    expect(await Bun.file(join(root, "agentcore", "aws-targets.json")).json()).toEqual([
      { name: "default", account: "123456789012", region: "us-east-2" },
    ]);
  });

  test("leaves existing deployment targets alone", async () => {
    const directory = await inTempDirectory();
    let detections = 0;
    const { manager: subject } = manager({
      resolveAccount: async () => {
        detections++;
        return "999999999999";
      },
    });
    const root = await scaffolded(subject, directory);
    const configured = [{ name: "prod", account: "555555555555", region: "eu-west-1" }];
    await writeFile(join(root, "agentcore", "aws-targets.json"), JSON.stringify(configured));

    await drain(subject.build({ path: root, region: "us-east-2" }));

    expect(detections).toBe(0);
    expect(await Bun.file(join(root, "agentcore", "aws-targets.json")).json()).toEqual(configured);
  });

  test("degrades to an actionable error when account detection fails", async () => {
    const directory = await inTempDirectory();
    const { manager: subject } = manager({
      resolveAccount: async () => {
        throw new Error("The security token included in the request is expired");
      },
    });
    const root = await scaffolded(subject, directory);

    const error = await drain(subject.build({ path: root, region: "us-east-2" })).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ProjectStateError);
    expect((error as Error).message).toContain("aws-targets.json");
    expect((error as Error).message).toContain("security token included in the request is expired");
    // The empty file is left for the user to fill in by hand.
    expect(await Bun.file(join(root, "agentcore", "aws-targets.json")).json()).toEqual([]);
  });

  test("surfaces a corrupt aws-targets.json instead of overwriting it", async () => {
    const directory = await inTempDirectory();
    const { manager: subject } = manager();
    const root = await scaffolded(subject, directory);
    await writeFile(join(root, "agentcore", "aws-targets.json"), "{ not json");

    await expect(drain(subject.build({ path: root, region: "us-east-2" }))).rejects.toBeInstanceOf(
      ProjectStateError,
    );
    expect(await Bun.file(join(root, "agentcore", "aws-targets.json")).text()).toBe("{ not json");
  });

  test("throws when no project encloses the path", async () => {
    const directory = await inTempDirectory();
    await expect(
      drain(manager().manager.build({ path: directory, region: "us-east-2" })),
    ).rejects.toBeInstanceOf(ProjectStateError);
  });

  test("streams subprocess output as project events", async () => {
    const directory = await inTempDirectory();
    const { manager: subject } = manager({
      runner: async (command, { onOutput }) => {
        onOutput?.(`${command.join(" ")}: line 1\n`);
        onOutput?.(`${command.join(" ")}: line 2\n`);
      },
    });
    const root = await scaffolded(subject, directory);

    const events = await drain(subject.build({ path: root, region: "us-east-2" }));

    expect(events.map((event) => event.subprocessOutput).filter(Boolean)).toEqual([
      "npm run build: line 1\n",
      "npm run build: line 2\n",
      "npx cdk synth: line 1\n",
      "npx cdk synth: line 2\n",
    ]);
  });

  test("forwards the region to the CDK subprocess environment", async () => {
    const directory = await inTempDirectory();
    const environments: (Record<string, string> | undefined)[] = [];
    const { manager: subject } = manager({
      runner: async (_command, { env }) => {
        environments.push(env);
      },
    });
    const root = await scaffolded(subject, directory);

    await drain(subject.build({ path: root, region: "us-east-2" }));

    // npm run build (tsc) has no use for a region; cdk synth gets it.
    expect(environments).toEqual([
      undefined,
      { AWS_REGION: "us-east-2", AWS_DEFAULT_REGION: "us-east-2" },
    ]);
  });

  test("a failed CDK step propagates after its streamed output", async () => {
    const directory = await inTempDirectory();
    const { manager: subject } = manager({
      runner: async (command, { onOutput }) => {
        if (command.includes("synth")) {
          onOutput?.("Error: no can do\n");
          throw new Error("cdk synth exploded");
        }
      },
    });
    const root = await scaffolded(subject, directory);

    const generator = subject.build({ path: root, region: "us-east-2" });
    const events: ProjectEvent[] = [];
    const error = await (async () => {
      try {
        for await (const event of generator) events.push(event);
      } catch (cause) {
        return cause;
      }
    })();

    expect(error).toEqual(new Error("cdk synth exploded"));
    expect(events.map((event) => event.subprocessOutput).filter(Boolean)).toEqual([
      "Error: no can do\n",
    ]);
  });
});

describe("FsProjectManager.deploy", () => {
  test("builds, bootstraps the target environment, and deploys", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    const root = await scaffolded(subject, directory);

    const events = await drain(subject.deploy({ path: root, region: "us-east-2" }));

    const cdkDir = join(root, "agentcore", "cdk");
    expect(commands).toEqual([
      { command: ["npm", "run", "build"], cwd: cdkDir },
      { command: ["npx", "cdk", "synth"], cwd: cdkDir },
      {
        command: [
          "npx",
          "cdk",
          "bootstrap",
          "aws://123456789012/us-east-2",
          "--bootstrap-customer-key",
        ],
        cwd: cdkDir,
      },
      { command: ["npx", "cdk", "deploy", "--all", "--require-approval", "never"], cwd: cdkDir },
    ]);
    // Build's events are delegated through, then deploy's own.
    expect(events.map((event) => event.message).filter(Boolean)).toEqual([
      "Detecting the AWS account for a default deployment target",
      "Configured default deployment target aws://123456789012/us-east-2",
      "Compiling the CDK app",
      "Synthesizing CloudFormation templates with cdk synth",
      "Bootstrapping aws://123456789012/us-east-2 with cdk bootstrap",
      "Deploying stacks with cdk deploy",
    ]);
  });

  test("bootstraps each distinct environment once", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    const root = await scaffolded(subject, directory);
    await writeFile(
      join(root, "agentcore", "aws-targets.json"),
      JSON.stringify([
        { name: "alpha", account: "111111111111", region: "us-east-1" },
        { name: "beta", account: "111111111111", region: "us-east-1" },
        { name: "gamma", account: "222222222222", region: "eu-west-1" },
      ]),
    );

    await drain(subject.deploy({ path: root, region: "us-east-2" }));

    const bootstraps = commands.filter(({ command }) => command.includes("bootstrap"));
    expect(bootstraps.map(({ command }) => command[3])).toEqual([
      "aws://111111111111/us-east-1",
      "aws://222222222222/eu-west-1",
    ]);
  });

  test("skipBootstrap skips cdk bootstrap", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    const root = await scaffolded(subject, directory);

    await drain(subject.deploy({ path: root, region: "us-east-2", skipBootstrap: true }));

    expect(commands.map(({ command }) => command.join(" "))).toEqual([
      "npm run build",
      "npx cdk synth",
      "npx cdk deploy --all --require-approval never",
    ]);
  });

  test("a failed deploy propagates", async () => {
    const directory = await inTempDirectory();
    const { manager: subject } = manager({
      runner: async (command) => {
        if (command.includes("deploy")) throw new Error("cdk deploy exploded");
      },
    });
    const root = await scaffolded(subject, directory);

    await expect(drain(subject.deploy({ path: root, region: "us-east-2" }))).rejects.toThrow(
      "cdk deploy exploded",
    );
  });
});
