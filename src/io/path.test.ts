import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePathInspector } from "./path";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("NodePathInspector", () => {
  test("checks path existence and identifies files", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentcore-path-inspector-"));
    directories.push(root);
    const file = join(root, "project.json");
    await writeFile(file, "{}");
    const subject = new NodePathInspector();

    expect(await subject.exists(root)).toBe(true);
    expect(await subject.exists(join(root, "missing"))).toBe(false);
    expect(await subject.isFile(root)).toBe(false);
    expect(await subject.isFile(file)).toBe(true);
    expect(await subject.isFile(join(root, "missing"))).toBe(false);
  });
});
