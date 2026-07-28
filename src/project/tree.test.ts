import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dir, file, writeTree } from "./tree";

const tempDirectories: string[] = [];

async function makeTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-tree-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("writeTree", () => {
  test("writes a nested tree to disk", async () => {
    const destination = await makeTempDirectory();
    const tree = dir("project", [
      file("agentcore.json", async () => "{}"),
      dir("app", [file("main.py", async () => "print('hi')")]),
    ]);

    await writeTree(tree, destination);

    const root = join(destination, "project");
    expect(await Bun.file(join(root, "agentcore.json")).text()).toBe("{}");
    expect(await Bun.file(join(root, "app", "main.py")).text()).toBe("print('hi')");
  });

  test("refuses to overwrite an existing file", async () => {
    const destination = await makeTempDirectory();
    const tree = dir("project", [file("keep.txt", async () => "new")]);

    await writeTree(tree, destination);
    await expect(writeTree(tree, destination)).rejects.toThrow(/Refusing to overwrite/);
    expect(await Bun.file(join(destination, "project", "keep.txt")).text()).toBe("new");
  });
});
