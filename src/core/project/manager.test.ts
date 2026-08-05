import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  AgentCoreCLIError,
  InputValidationError,
  NestedProjectError,
  ProjectFileExistsError,
} from "../../errors";
import { FsProjectManager } from "./manager";
import { PROJECT_TEMPLATES } from "../../handlers/project/types";
import { createSilentLogger } from "../../testing";
import { defaultAssetSource, localFileSystem } from "../../io";
import { toStackName } from "../../assets/cdk/lib/names";

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
      source: defaultAssetSource(localFileSystem),
      runner: async (command, { cwd }) => {
        commands.push({ command, cwd });
        if (command.includes("synth")) {
          const configDir = join(cwd, "..");
          const project = await Bun.file(join(configDir, "agentcore.json")).json();
          const targets = (await Bun.file(join(configDir, "aws-targets.json")).json()) as {
            name: string;
          }[];
          const artifacts = Object.fromEntries(
            targets.map((target) => {
              const stackName = toStackName(project.name, target.name);
              return [
                stackName,
                {
                  type: "aws:cloudformation:stack",
                  properties: { stackName },
                },
              ];
            }),
          );
          const assembly = join(cwd, "cdk.out");
          await mkdir(assembly, { recursive: true });
          await writeFile(
            join(assembly, "manifest.json"),
            JSON.stringify({ version: "48.0.0", artifacts }),
          );
        }
      },
      checkTool: async () => {}, // CI hosts don't have uv installed
      fileSystem: localFileSystem,
      workingDirectory: () => process.cwd(),
      now: () => new Date("2026-08-05T12:00:00.000Z"),
    }),
    commands,
  };
}

async function configureTarget(projectRoot: string, name = "default"): Promise<void> {
  await writeFile(
    join(projectRoot, "agentcore", "aws-targets.json"),
    JSON.stringify([
      {
        name,
        account: "123456789012",
        region: "us-east-1",
      },
    ]),
  );
}

describe("FsProjectManager.create", () => {
  test("scaffolds the expected file tree into a fresh directory", async () => {
    const directory = await inTempDirectory();
    await manager().manager.create({
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
    await manager().manager.create({
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

    await manager().manager.create(input);
    await expect(manager().manager.create(input)).rejects.toBeInstanceOf(ProjectFileExistsError);
  });

  test("runs npm install, uv sync, and git init after scaffolding", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    await subject.create({ name: "example", template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON });

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
    await subject.create({
      name: "example",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
      skipInstall: true,
    });

    expect(commands).toEqual([{ command: ["git", "init"], cwd: join(directory, "example") }]);
  });

  test("skipGit skips git init", async () => {
    await inTempDirectory();
    const { manager: subject, commands } = manager();
    await subject.create({
      name: "example",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
      skipGit: true,
    });

    expect(commands.map(({ command }) => command[0])).toEqual(["npm", "uv"]);
  });

  test("reports each step through onProgress", async () => {
    await inTempDirectory();
    const messages: string[] = [];
    await manager().manager.create({
      name: "example",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
      onProgress: (event) => messages.push(event.message),
    });

    expect(messages).toEqual([
      "Scaffolding project files...",
      "Installing CDK dependencies (npm install)...",
      "Syncing Python dependencies (uv sync)...",
      "Initializing git repository...",
    ]);
  });

  test("a failed step propagates and leaves the scaffolded files in place", async () => {
    const directory = await inTempDirectory();
    const failing = new FsProjectManager({
      logger: createSilentLogger(),
      source: defaultAssetSource(localFileSystem),
      runner: async () => {
        throw new Error("npm exploded");
      },
      checkTool: async () => {},
      fileSystem: localFileSystem,
      workingDirectory: () => process.cwd(),
      now: () => new Date(),
    });

    await expect(
      failing.create({ name: "example", template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON }),
    ).rejects.toThrow("npm exploded");
    expect(await Bun.file(join(directory, "example", "agentcore", "agentcore.json")).exists()).toBe(
      true,
    );
  });

  test("refuses to create a project inside an existing project", async () => {
    const directory = await inTempDirectory();
    await manager().manager.create({
      name: "root",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
    });

    process.chdir(join(directory, "root"));
    await expect(
      manager().manager.create({ name: "child", template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON }),
    ).rejects.toBeInstanceOf(NestedProjectError);
  });
});

describe("FsProjectManager.resolve", () => {
  test("finds the enclosing project from a nested path", async () => {
    const directory = await inTempDirectory();
    const subject = manager().manager;
    await subject.create({
      name: "example",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
      skipInstall: true,
      skipGit: true,
    });
    const projectRoot = join(directory, "example");
    await configureTarget(projectRoot);
    const nested = join(projectRoot, "app", "hello-world");

    const project = await subject.resolve({ filePath: nested });

    expect(project).toEqual({
      name: "example",
      root: projectRoot,
      configDir: join(projectRoot, "agentcore"),
      managedBy: "CDK",
      targets: [
        {
          name: "default",
          account: "123456789012",
          region: "us-east-1",
        },
      ],
    });
  });

  test("returns undefined outside a project", async () => {
    const directory = await inTempDirectory();
    expect(await manager().manager.resolve({ filePath: directory })).toBeUndefined();
  });
});

describe("FsProjectManager.build", () => {
  test("compiles, synthesizes every target, and writes a build manifest", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    await subject.create({
      name: "example",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
      skipInstall: true,
      skipGit: true,
    });
    const projectRoot = join(directory, "example");
    await configureTarget(projectRoot);
    commands.length = 0;

    const messages: string[] = [];
    const result = await subject.build({
      filePath: join(projectRoot, "app", "hello-world"),
      onProgress: ({ message }) => messages.push(message),
    });

    const cdkDirectory = join(projectRoot, "agentcore", "cdk");
    expect(commands).toEqual([
      { command: ["npm", "run", "build"], cwd: cdkDirectory },
      {
        command: [
          "node",
          join("node_modules", "aws-cdk", "bin", "cdk"),
          "synth",
          "--output",
          "cdk.out",
          "--quiet",
        ],
        cwd: cdkDirectory,
      },
    ]);
    expect(result).toMatchObject({
      version: 1,
      projectName: "example",
      backend: "CDK",
      builtAt: "2026-08-05T12:00:00.000Z",
      artifact: {
        type: "cdk-cloud-assembly",
        path: "agentcore/cdk/cdk.out",
        stacks: {
          default: "AgentCore-example-default",
        },
      },
      manifestPath: "agentcore/.build/manifest.json",
      targets: [
        {
          name: "default",
          account: "123456789012",
          region: "us-east-1",
        },
      ],
    });
    expect(result.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const { manifestPath: _manifestPath, ...manifest } = result;
    expect(
      await Bun.file(join(projectRoot, "agentcore", ".build", "manifest.json")).json(),
    ).toEqual(manifest);
    expect(messages).toEqual([
      "Compiling CDK application...",
      "Validating project and synthesizing deployment artifacts...",
      "Recording build manifest...",
    ]);
  });

  test("changes the fingerprint when project source changes", async () => {
    const directory = await inTempDirectory();
    const subject = manager().manager;
    await subject.create({
      name: "example",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
      skipInstall: true,
      skipGit: true,
    });
    const projectRoot = join(directory, "example");
    await configureTarget(projectRoot);

    const first = await subject.build({ filePath: projectRoot });
    await writeFile(join(projectRoot, "app", "hello-world", "new.py"), "print('changed')\n");
    const second = await subject.build({ filePath: projectRoot });

    expect(second.inputFingerprint).not.toBe(first.inputFingerprint);
  });

  test("classifies malformed CDK output as an internal build failure", async () => {
    const directory = await inTempDirectory();
    const subject = new FsProjectManager({
      logger: createSilentLogger(),
      source: defaultAssetSource(localFileSystem),
      runner: async (command, { cwd }) => {
        if (command.includes("synth")) {
          const assembly = join(cwd, "cdk.out");
          await mkdir(assembly, { recursive: true });
          await writeFile(join(assembly, "manifest.json"), "{}");
        }
      },
      checkTool: async () => {},
      fileSystem: localFileSystem,
      workingDirectory: () => process.cwd(),
      now: () => new Date(),
    });
    await subject.create({
      name: "example",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
      skipInstall: true,
      skipGit: true,
    });
    const projectRoot = join(directory, "example");
    await configureTarget(projectRoot);

    const error = await subject.build({ filePath: projectRoot }).catch((cause) => cause);

    expect(error).toBeInstanceOf(AgentCoreCLIError);
    expect(error).not.toBeInstanceOf(InputValidationError);
    expect(error).toMatchObject({ source: "internal" });
  });

  test("rejects a project without deployment targets before spawning a build", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    await subject.create({
      name: "example",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
      skipInstall: true,
      skipGit: true,
    });
    commands.length = 0;

    await expect(subject.build({ filePath: join(directory, "example") })).rejects.toThrow(
      /No deployment targets configured/,
    );
    expect(commands).toEqual([]);
  });

  test("rejects an unsupported backend before spawning a build", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    await subject.create({
      name: "example",
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
      skipInstall: true,
      skipGit: true,
    });
    const projectRoot = join(directory, "example");
    await configureTarget(projectRoot);
    const specPath = join(projectRoot, "agentcore", "agentcore.json");
    const spec = await Bun.file(specPath).json();
    await writeFile(specPath, JSON.stringify({ ...spec, managedBy: "Terraform" }));
    commands.length = 0;

    await expect(subject.build({ filePath: projectRoot })).rejects.toThrow(
      /backend "Terraform" is not supported/,
    );
    expect(commands).toEqual([]);
  });
});
