import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  InvalidProjectConfigError,
  NestedProjectError,
  ProjectFileExistsError,
} from "../../errors";
import { FsProjectManager } from "./manager";
import { PROJECT_TEMPLATES } from "../../handlers/project/types";
import { createSilentLogger } from "../../testing";

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-manager-"));
  tempDirectories.push(directory);
  process.chdir(directory);
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

describe("FsProjectManager.create", () => {
  test.each(Object.values(PROJECT_TEMPLATES))(
    "scaffolds the expected file tree for %s into a fresh directory",
    async (template) => {
      const directory = await inTempDirectory();
      await manager().manager.create({ name: "example", parentDirectory: directory, template });

      const projectRoot = join(directory, "example");
      const manifest = (await readdir(projectRoot, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) =>
          relative(projectRoot, join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
        )
        .sort();

      expect(manifest).toMatchSnapshot();
    },
  );

  test("writes a deploy-ready agentcore.json registering the template agent", async () => {
    const directory = await inTempDirectory();
    await manager().manager.create({
      name: "example",
      parentDirectory: directory,
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

  test("registers a Container runtime with its Dockerfile for the container template", async () => {
    const directory = await inTempDirectory();
    await manager().manager.create({
      name: "example",
      parentDirectory: directory,
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON_CONTAINER,
    });

    const spec = await Bun.file(join(directory, "example", "agentcore", "agentcore.json")).json();
    expect(spec.runtimes).toEqual([
      {
        name: "hello_world",
        build: "Container",
        entrypoint: "main.py",
        codeLocation: "app/hello-world",
        dockerfile: "Dockerfile",
      },
    ]);
  });

  test("refuses to overwrite an existing project", async () => {
    const directory = await inTempDirectory();
    const input = {
      name: "example",
      parentDirectory: directory,
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
    };

    await manager().manager.create(input);
    await expect(manager().manager.create(input)).rejects.toBeInstanceOf(ProjectFileExistsError);
  });

  test("runs npm install, uv sync, and git init after scaffolding", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    await subject.create({
      name: "example",
      parentDirectory: directory,
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
    });

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
      parentDirectory: directory,
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
      skipInstall: true,
    });

    expect(commands).toEqual([{ command: ["git", "init"], cwd: join(directory, "example") }]);
  });

  test("skipGit skips git init", async () => {
    const directory = await inTempDirectory();
    const { manager: subject, commands } = manager();
    await subject.create({
      name: "example",
      parentDirectory: directory,
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
      skipGit: true,
    });

    expect(commands.map(({ command }) => command[0])).toEqual(["npm", "uv"]);
  });

  test("reports each step through onProgress", async () => {
    const directory = await inTempDirectory();
    const messages: string[] = [];
    await manager().manager.create({
      name: "example",
      parentDirectory: directory,
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
      failing.create({
        name: "example",
        parentDirectory: directory,
        template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
      }),
    ).rejects.toThrow("npm exploded");
    expect(await Bun.file(join(directory, "example", "agentcore", "agentcore.json")).exists()).toBe(
      true,
    );
  });

  test("refuses to create a project inside an existing project", async () => {
    const directory = await inTempDirectory();
    await manager().manager.create({
      name: "root",
      parentDirectory: directory,
      template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
    });

    await expect(
      manager().manager.create({
        name: "child",
        parentDirectory: join(directory, "root"),
        template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON,
      }),
    ).rejects.toBeInstanceOf(NestedProjectError);
  });
});

describe("FsProjectManager.resolve", () => {
  test.each(Object.values(PROJECT_TEMPLATES))(
    "round-trips a created %s project from a nested subdirectory",
    async (template) => {
      const directory = await inTempDirectory();
      const created = await manager().manager.create({
        name: "example",
        parentDirectory: directory,
        template,
      });

      const resolved = await manager().manager.resolve({
        filePath: join(directory, "example", "app", "hello-world"),
      });

      expect(resolved).toEqual(created);
      expect(resolved?.rootPath).toBe(join(directory, "example"));
    },
  );

  test("returns undefined when no project encloses the path", async () => {
    const directory = await inTempDirectory();
    expect(await manager().manager.resolve({ filePath: directory })).toBeUndefined();
  });

  test("throws InvalidProjectConfigError for malformed JSON", async () => {
    const directory = await inTempDirectory();
    await mkdir(join(directory, "agentcore"), { recursive: true });
    await Bun.write(join(directory, "agentcore", "agentcore.json"), "{ not json");

    await expect(manager().manager.resolve({ filePath: directory })).rejects.toBeInstanceOf(
      InvalidProjectConfigError,
    );
  });

  test("throws InvalidProjectConfigError when the spec fails validation", async () => {
    const directory = await inTempDirectory();
    await mkdir(join(directory, "agentcore"), { recursive: true });
    await Bun.write(
      join(directory, "agentcore", "agentcore.json"),
      JSON.stringify({ name: "example", runtimes: [{ name: "broken" }] }),
    );

    await expect(manager().manager.resolve({ filePath: directory })).rejects.toBeInstanceOf(
      InvalidProjectConfigError,
    );
  });

  test("rejects a spec carrying keys the schema does not model", async () => {
    const directory = await inTempDirectory();
    await mkdir(join(directory, "agentcore"), { recursive: true });
    await Bun.write(
      join(directory, "agentcore", "agentcore.json"),
      JSON.stringify({
        name: "example",
        version: 1,
        managedBy: "CDK",
        runtmes: [],
      }),
    );

    await expect(manager().manager.resolve({ filePath: directory })).rejects.toBeInstanceOf(
      InvalidProjectConfigError,
    );
  });
});
