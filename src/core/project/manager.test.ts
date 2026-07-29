import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { FsProjectManager } from "./manager";
import { ProjectFileExistsError } from "./tree";
import { PROJECT_TEMPLATES } from "../../handlers/project/types";
import { createSilentLogger } from "../../testing";

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-manager-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  return directory;
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function manager(): FsProjectManager {
  return new FsProjectManager({ logger: createSilentLogger() });
}

describe("FsProjectManager.create", () => {
  test("scaffolds the expected file tree into a fresh directory", async () => {
    const directory = await inTempDirectory();
    await manager().create({ name: "example", template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON });

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
    await manager().create({ name: "example", template: PROJECT_TEMPLATES.HELLO_WORLD_PYTHON });

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

    await manager().create(input);
    await expect(manager().create(input)).rejects.toBeInstanceOf(ProjectFileExistsError);
  });
});
