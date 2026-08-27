import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parseEnv } from "node:util";
import { CLIENT_SECRET_SUFFIX, credentialEnvVarName, EnvLocalFile } from "./envLocal";

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

test("credentialEnvVarName upcases, replaces hyphens, and appends the suffix", () => {
  expect(credentialEnvVarName("openai-key")).toBe("AGENTCORE_CREDENTIAL_OPENAI_KEY");
  expect(credentialEnvVarName("my-oauth", CLIENT_SECRET_SUFFIX)).toBe(
    "AGENTCORE_CREDENTIAL_MY_OAUTH_CLIENT_SECRET",
  );
});
