import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { InputValidationError, NestedProjectError, ProjectFileExistsError } from "../../errors";
import { FsProjectManager } from "./manager";
import { PROJECT_TEMPLATES } from "../../handlers/project/types";
import { createSilentLogger } from "../../testing";

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

async function writeProject(
  root: string,
  options: {
    agentcore?: unknown;
    targets?: unknown;
  } = {},
): Promise<void> {
  const configDir = join(root, "agentcore");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "agentcore.json"),
    JSON.stringify(
      options.agentcore ?? {
        name: "Example",
        version: 1,
        managedBy: "CDK",
      },
    ),
  );
  await writeFile(join(configDir, "aws-targets.json"), JSON.stringify(options.targets ?? []));
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
      runner: async () => {
        throw new Error("npm exploded");
      },
      checkTool: async () => {},
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
  test("loads build inputs from a nested project directory", async () => {
    const directory = await inTempDirectory();
    const root = join(directory, "example");
    await writeProject(root, {
      targets: [
        {
          name: "production",
          description: "production environment",
          account: "123456789012",
          region: "us-west-2",
        },
      ],
    });
    const nested = join(root, "app", "service");
    await mkdir(nested, { recursive: true });

    await expect(manager().manager.resolve({ filePath: nested })).resolves.toEqual({
      name: "Example",
      root,
      configDir: join(root, "agentcore"),
      managedBy: "CDK",
      targets: [
        {
          name: "production",
          description: "production environment",
          account: "123456789012",
          region: "us-west-2",
        },
      ],
    });
  });

  test("locates a project from a file within it", async () => {
    const directory = await inTempDirectory();
    const root = join(directory, "example");
    await writeProject(root);
    const source = join(root, "app", "main.py");
    await mkdir(join(root, "app"), { recursive: true });
    await writeFile(source, "print('hello')\n");

    await expect(manager().manager.resolve({ filePath: source })).resolves.toMatchObject({
      root,
      configDir: join(root, "agentcore"),
    });
  });

  test("returns undefined when no project marker exists", async () => {
    const directory = await inTempDirectory();

    await expect(manager().manager.resolve({ filePath: directory })).resolves.toBeUndefined();
  });

  test("defaults a missing project backend to CDK and permits empty targets", async () => {
    const directory = await inTempDirectory();
    await writeProject(join(directory, "example"), {
      agentcore: {
        name: "Example",
        version: 1,
      },
    });

    await expect(
      manager().manager.resolve({ filePath: join(directory, "example") }),
    ).resolves.toMatchObject({
      managedBy: "CDK",
      targets: [],
    });
  });

  test("rejects invalid project metadata", async () => {
    const directory = await inTempDirectory();
    const root = join(directory, "example");
    await writeProject(root, {
      agentcore: {
        name: "1-invalid",
        version: 1,
      },
    });

    await expect(manager().manager.resolve({ filePath: root })).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });

  test("rejects duplicate deployment target names", async () => {
    const directory = await inTempDirectory();
    const root = join(directory, "example");
    await writeProject(root, {
      targets: [
        {
          name: "development",
          account: "123456789012",
          region: "us-east-1",
        },
        {
          name: "development",
          account: "210987654321",
          region: "us-west-2",
        },
      ],
    });

    await expect(manager().manager.resolve({ filePath: root })).rejects.toBeInstanceOf(
      InputValidationError,
    );
  });
});
