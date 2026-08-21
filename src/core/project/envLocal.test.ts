import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { EnvLocalFile } from "./envLocal";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "envlocal-"));
  roots.push(root);
  // Real projects always have the agentcore/ dir; the class does not create it.
  await mkdir(dirname(new EnvLocalFile(root).path), { recursive: true });
  return root;
}

const ENTRY = { key: "SECRET", value: "v", comment: "c" };

test("rollback deletes the file it created", async () => {
  const root = await tempRoot();
  const file = new EnvLocalFile(root);
  await file.upsert([ENTRY]);
  expect(existsSync(file.path)).toBe(true);

  await file.rollback();
  expect(existsSync(file.path)).toBe(false);
});

test("rollback restores the prior content of an existing file", async () => {
  const root = await tempRoot();
  const file = new EnvLocalFile(root);
  await Bun.write(file.path, "EXISTING=1\n");

  await file.upsert([ENTRY]);
  expect(await Bun.file(file.path).text()).toContain("SECRET=v");

  await file.rollback();
  expect(await Bun.file(file.path).text()).toBe("EXISTING=1\n");
});

test("rollback is a no-op when upsert wrote nothing", async () => {
  const root = await tempRoot();
  const file = new EnvLocalFile(root);
  await Bun.write(file.path, "SECRET=kept\n");

  await file.upsert([ENTRY]); // key already present, so nothing is written
  await file.rollback();
  expect(await Bun.file(file.path).text()).toBe("SECRET=kept\n");
});
