import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptSecret } from "../secrets/cipher";
import { LocalSecrets, type KeychainEntry } from "./localSecrets";

const roots: string[] = [];
afterEach(() =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentcore-secret-key-"));
  roots.push(root);
  return root;
}

test("creates and reuses the 32-byte owner-only fallback key", async () => {
  const configDirectory = await directory();
  const config = { configDirectory, keychain: () => null };
  const encrypted = await new LocalSecrets(config).encrypt({ MODEL_API_KEY: "private-value" });
  const path = join(configDirectory, "secrets.key");
  const key = await readFile(path);
  expect(key.length).toBe(32);
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await chmod(path, 0o644);
  }
  expect(await new LocalSecrets(config).decrypt(encrypted)).toEqual({
    MODEL_API_KEY: "private-value",
  });
  await new LocalSecrets(config).encrypt({ MODEL_API_KEY: "next-value" });
  expect(await readFile(path)).toEqual(key);
  let keychainReads = 0;
  const available = new LocalSecrets({
    configDirectory,
    keychain: () => {
      keychainReads++;
      return { getPassword: () => randomBytes(32).toString("base64"), setPassword: () => {} };
    },
  });
  const next = await available.encrypt({ MODEL_API_KEY: "file-preferred" });
  expect(await available.decrypt(next)).toEqual({ MODEL_API_KEY: "file-preferred" });
  expect(keychainReads).toBe(0);
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("uses the persisted keychain key without creating a keyfile", async () => {
  const configDirectory = await directory();
  let password: string | null = null;
  const entry: KeychainEntry = {
    getPassword: () => password,
    setPassword: (value) => {
      password = value;
    },
  };
  const config = { configDirectory, keychain: () => entry };
  const encrypted = await new LocalSecrets(config).encrypt({ MODEL_API_KEY: "private-value" });
  expect(password).not.toBeNull();
  expect(existsSync(join(configDirectory, "secrets.key"))).toBe(false);
  expect(await new LocalSecrets(config).decrypt(encrypted)).toEqual({
    MODEL_API_KEY: "private-value",
  });
});

test("encrypts with the persisted key rather than a generated key the store replaced", async () => {
  const configDirectory = await directory();
  const persisted = randomBytes(32).toString("base64");
  let password: string | null = null;
  const config = {
    configDirectory,
    keychain: () => ({
      getPassword: () => password,
      setPassword: () => {
        password = persisted;
      },
    }),
  };
  const encrypted = await new LocalSecrets(config).encrypt({ MODEL_API_KEY: "value" });
  expect(await new LocalSecrets(config).decrypt(encrypted)).toEqual({ MODEL_API_KEY: "value" });
});

test("falls back when keychain access fails and reads values encrypted by either source", async () => {
  const configDirectory = await directory();
  const keychainKey = randomBytes(32);
  const fileOnly = new LocalSecrets({ configDirectory, keychain: () => null });
  const fromFile = await fileOnly.encrypt({ FILE_API_KEY: "file-value" });
  const secrets = new LocalSecrets({
    configDirectory,
    keychain: () => ({
      getPassword: () => keychainKey.toString("base64"),
      setPassword: () => {
        throw new Error("must not overwrite an existing key");
      },
    }),
  });
  expect(
    await secrets.decrypt({
      ...fromFile,
      KEYCHAIN_API_KEY: encryptSecret("keychain-value", keychainKey),
    }),
  ).toEqual({ FILE_API_KEY: "file-value", KEYCHAIN_API_KEY: "keychain-value" });

  const unavailable = new LocalSecrets({
    configDirectory,
    keychain: () => {
      throw new Error("keychain unavailable");
    },
  });
  expect(await unavailable.decrypt(await unavailable.encrypt({ MODEL_API_KEY: "value" }))).toEqual({
    MODEL_API_KEY: "value",
  });
});

test("does not create keys for identifiers, blank placeholders, plaintext reads or encrypted writes", async () => {
  const configDirectory = await directory();
  const secrets = new LocalSecrets({ configDirectory, keychain: () => null });
  const env = { AGENTCORE_CREDENTIAL_PAY_API_KEY_ID: "id", MODEL_API_KEY: "", STAGE: "dev" };
  expect(await secrets.encrypt(env)).toEqual(env);
  expect(await secrets.decrypt({ MODEL_API_KEY: "legacy" })).toEqual({ MODEL_API_KEY: "legacy" });
  const token = encryptSecret("value", randomBytes(32));
  expect(await secrets.encrypt({ MODEL_API_KEY: token })).toEqual({ MODEL_API_KEY: token });
  expect(existsSync(join(configDirectory, "secrets.key"))).toBe(false);
});

test("missing and corrupt keys fail without replacing key material or leaking a stored value", async () => {
  const configDirectory = await directory();
  const path = join(configDirectory, "secrets.key");
  const secrets = new LocalSecrets({ configDirectory, keychain: () => null });
  const token = encryptSecret("private-value", randomBytes(32));
  await expect(secrets.decrypt({ MODEL_API_KEY: token })).rejects.toThrow(/Could not decrypt/);
  expect(existsSync(path)).toBe(false);
  const corrupt = Buffer.alloc(10, 7);
  await writeFile(path, corrupt);
  await expect(secrets.encrypt({ MODEL_API_KEY: "private-value" })).rejects.toThrow(/is corrupt/);
  await expect(secrets.decrypt({ MODEL_API_KEY: token })).rejects.toThrow(/Could not decrypt/);
  expect(await readFile(path)).toEqual(corrupt);
});

test("a keychain read failure never replaces an existing key", async () => {
  const configDirectory = await directory(),
    original = randomBytes(32);
  let password = original.toString("base64"),
    denied = true,
    writes = 0;
  const config = {
    configDirectory,
    keychain: () => ({
      getPassword: () => {
        if (denied) throw new Error("access denied");
        return password;
      },
      setPassword: (value: string) => {
        writes++;
        password = value;
      },
    }),
  };
  const encrypted = await new LocalSecrets(config).encrypt({ NEW_API_KEY: "new-value" });
  expect(writes).toBe(0);
  expect(password).toBe(original.toString("base64"));
  denied = false;
  expect(
    await new LocalSecrets(config).decrypt({
      ...encrypted,
      OLD_API_KEY: encryptSecret("old-value", original),
    }),
  ).toEqual({ NEW_API_KEY: "new-value", OLD_API_KEY: "old-value" });
});
