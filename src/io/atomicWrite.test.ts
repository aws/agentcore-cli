import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./atomicWrite";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "atomic-write-"));
  dirs.push(d);
  return d;
}

test("writes contents and leaves no temp file", async () => {
  const dir = await tempDir();
  const target = join(dir, "out.txt");

  await atomicWrite(target, "hello");

  expect(await Bun.file(target).text()).toBe("hello");
  expect(await readdir(dir)).toEqual(["out.txt"]);
});

test("overwrites an existing file", async () => {
  const dir = await tempDir();
  const target = join(dir, "out.txt");
  await writeFile(target, "old");

  await atomicWrite(target, "new");

  expect(await Bun.file(target).text()).toBe("new");
  expect(await readdir(dir)).toEqual(["out.txt"]);
});

test("cleans up the temp file when rename fails", async () => {
  const dir = await tempDir();
  // Target path is a directory → rename onto it fails, exercising the catch.
  const target = join(dir, "adir");
  await Bun.write(join(target, "keep"), "x");

  await expect(atomicWrite(target, "data")).rejects.toThrow();
  expect(await readdir(dir)).toEqual(["adir"]);
});
