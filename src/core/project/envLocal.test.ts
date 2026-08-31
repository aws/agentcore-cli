import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
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
const testPosix = process.platform === "win32" ? test.skip : test;

testPosix("creates and replaces the secrets file with owner-only permissions", async () => {
  const root = await tempRoot();
  const file = new EnvLocalFile(root);

  await file.insertIfNew([ENTRY]);
  expect((await stat(file.path)).mode & 0o777).toBe(0o600);

  await chmod(file.path, 0o644);
  await file.insertIfNew([ENTRY]);
  expect((await stat(file.path)).mode & 0o777).toBe(0o600);

  await chmod(file.path, 0o644);
  await file.insertIfNew([{ key: "SECOND", value: "v", comment: "c" }]);
  expect((await stat(file.path)).mode & 0o777).toBe(0o600);

  await file.rollback();
  expect((await stat(file.path)).mode & 0o777).toBe(0o600);
});

test("rollback deletes the file it created", async () => {
  const root = await tempRoot();
  const file = new EnvLocalFile(root);
  await file.insertIfNew([ENTRY]);
  expect(existsSync(file.path)).toBe(true);

  await file.rollback();
  expect(existsSync(file.path)).toBe(false);
});

test("rollback restores the prior content of an existing file", async () => {
  const root = await tempRoot();
  const file = new EnvLocalFile(root);
  await Bun.write(file.path, "EXISTING=1\n");

  await file.insertIfNew([ENTRY]);
  expect(await Bun.file(file.path).text()).toContain("SECRET='v'");

  await file.rollback();
  expect(await Bun.file(file.path).text()).toBe("EXISTING=1\n");
});

test("rollback is a no-op when insertIfNew wrote nothing", async () => {
  const root = await tempRoot();
  const file = new EnvLocalFile(root);
  await Bun.write(file.path, "SECRET=kept\n");

  await file.insertIfNew([ENTRY]); // key already present, so nothing is written
  await file.rollback();
  expect(await Bun.file(file.path).text()).toBe("SECRET=kept\n");
});

test.each([
  ["left#right", "left#right"],
  ["  padded  ", "  padded  "],
  ['has"double', 'has"double'],
  ["back\\slash", "back\\slash"],
  ["dollar$sign", "dollar$sign"],
])("a value with %p round-trips through parseEnv", async (value, expected) => {
  const root = await tempRoot();
  const file = new EnvLocalFile(root);
  await file.insertIfNew([{ key: "SECRET", value, comment: "c" }]);

  const parsed = parseEnv(await Bun.file(file.path).text()) as Record<string, string>;
  expect(parsed.SECRET).toBe(expected);
});

test("rejects a value that contains a single quote", async () => {
  const root = await tempRoot();
  const file = new EnvLocalFile(root);
  await expect(file.insertIfNew([{ key: "SECRET", value: "a'b", comment: "c" }])).rejects.toThrow(
    /single quote/,
  );
});

test("read returns {} when the file does not exist", async () => {
  const root = await tempRoot();
  expect(await new EnvLocalFile(root).read()).toEqual({});
});

test("read parses back the entries insertIfNew wrote", async () => {
  const root = await tempRoot();
  const file = new EnvLocalFile(root);
  await file.insertIfNew([{ key: "SECRET", value: "s k", comment: "c" }]);

  expect(await file.read()).toEqual({ SECRET: "s k" });
});

test("removeKeys deletes an entry and its comment while leaving neighbors", async () => {
  const root = await tempRoot();
  const file = new EnvLocalFile(root);
  await file.insertIfNew([
    { key: "KEEP", value: "1", comment: "kept entry" },
    { key: "DROP", value: "2", comment: "dropped entry" },
  ]);

  const result = await file.removeKeys(["DROP"]);

  expect(result).toEqual({ removed: ["DROP"], missing: [] });
  expect(await Bun.file(file.path).text()).toBe("# kept entry\nKEEP='1'\n");
});

test("removeKeys reports keys that are not present without rewriting the file", async () => {
  const root = await tempRoot();
  const file = new EnvLocalFile(root);
  await Bun.write(file.path, "USER_MANAGED=1\n");

  const result = await file.removeKeys(["ABSENT"]);

  expect(result).toEqual({ removed: [], missing: ["ABSENT"] });
  expect(await Bun.file(file.path).text()).toBe("USER_MANAGED=1\n");
  await file.rollback(); // nothing was written, so nothing to restore
  expect(await Bun.file(file.path).text()).toBe("USER_MANAGED=1\n");
});

test("removeKeys on a missing file reports every key as missing", async () => {
  const root = await tempRoot();
  const file = new EnvLocalFile(root);

  expect(await file.removeKeys(["A", "B"])).toEqual({ removed: [], missing: ["A", "B"] });
  expect(existsSync(file.path)).toBe(false);
});

test("removeKeys never deletes a non-comment line above the entry", async () => {
  const root = await tempRoot();
  const file = new EnvLocalFile(root);
  await Bun.write(file.path, "USER_MANAGED=1\nDROP=2\n");

  await file.removeKeys(["DROP"]);

  expect(await Bun.file(file.path).text()).toBe("USER_MANAGED=1\n");
});

test("rollback restores the content removeKeys deleted", async () => {
  const root = await tempRoot();
  const file = new EnvLocalFile(root);
  await Bun.write(file.path, "# api key\nSECRET='v'\nOTHER=1\n");

  await file.removeKeys(["SECRET"]);
  expect(await Bun.file(file.path).text()).toBe("OTHER=1\n");

  await file.rollback();
  expect(await Bun.file(file.path).text()).toBe("# api key\nSECRET='v'\nOTHER=1\n");
});

testPosix("removeKeys keeps owner-only permissions on the rewritten file", async () => {
  const root = await tempRoot();
  const file = new EnvLocalFile(root);
  await Bun.write(file.path, "# c\nDROP='v'\nKEEP=1\n");
  await chmod(file.path, 0o644);

  await file.removeKeys(["DROP"]);

  expect((await stat(file.path)).mode & 0o777).toBe(0o600);
});
