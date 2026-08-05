import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeLocalFileSystem } from "./fileSystem";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("NodeLocalFileSystem", () => {
  test("implements project filesystem operations behind one IO boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentcore-file-system-"));
    directories.push(root);
    const subject = new NodeLocalFileSystem();
    const directory = join(root, "nested");
    const file = join(directory, "value.txt");

    await subject.createDirectory(directory);
    await subject.writeAtomic(file, "value");

    expect(await subject.exists(file)).toBe(true);
    expect(await subject.readText(file)).toBe("value");
    expect(await subject.stat(file)).toMatchObject({ kind: "file" });
    expect(await subject.readDirectory(directory)).toEqual([{ name: "value.txt", kind: "file" }]);

    await subject.remove(directory);
    expect(await subject.exists(file)).toBe(false);
  });
});
