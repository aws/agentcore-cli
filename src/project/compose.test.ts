import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { projectTree } from "./compose";
import { fileSource } from "./source";
import { writeTree } from "./tree";
import { PROJECT_TEMPLATES } from "../handlers/project/types";

const tempDirectories: string[] = [];

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-compose-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("projectTree", () => {
  // Renders the real hello-world-python tree from disk and snapshots the file
  // manifest, so adding/removing/renaming a scaffolded file is a reviewable diff.
  test("scaffolds the expected file tree", async () => {
    const destination = await makeTempDirectory();
    const tree = await projectTree("example", PROJECT_TEMPLATES.HELLO_WORLD_PYTHON, fileSource());
    await writeTree(tree, destination);

    const manifest = (await readdir(destination, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) =>
        relative(destination, join(entry.parentPath, entry.name)).replaceAll("\\", "/"),
      )
      .sort();

    expect(manifest).toMatchSnapshot();
  });

  test("writes a deploy-ready agentcore.json registering the template agent", async () => {
    const destination = await makeTempDirectory();
    const tree = await projectTree("example", PROJECT_TEMPLATES.HELLO_WORLD_PYTHON, fileSource());
    await writeTree(tree, destination);

    const spec = await Bun.file(join(destination, "agentcore.json")).json();
    expect(spec.name).toBe("example");
    expect(spec.runtimes).toEqual([
      {
        name: "hello-world",
        build: "CodeZip",
        entrypoint: "main.py",
        codeLocation: "app/hello-world",
      },
    ]);
    expect(await Bun.file(join(destination, "agentcore", "aws-targets.json")).json()).toEqual([]);
  });
});
