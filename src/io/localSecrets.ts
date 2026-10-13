import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FileWriteError, ProjectStateError } from "../errors";
import { ENC_PREFIX, decryptSecret, encryptSecret } from "../secrets/cipher";
import { isSensitiveKey } from "../secrets/sensitiveKeys";
import { loadKeyring } from "./keyring";

const KEY_BYTES = 32;
const KEYCHAIN_SERVICE = "aws-agentcore";
const KEYCHAIN_ACCOUNT = "env-local-secret-key";

export interface KeychainEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
}

type LocalSecretsConfig = {
  configDirectory?: string;
  keychain?: () => KeychainEntry | null;
};

function defaultKeychain(): KeychainEntry | null {
  if (process.env.AGENTCORE_DISABLE_KEYCHAIN === "1") return null;
  try {
    const { Entry } = loadKeyring();
    return new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  } catch {
    return null;
  }
}

/** Machine-local key storage shared by project environment-file reads and writes. */
export class LocalSecrets {
  private key?: Buffer;
  private readonly directory: string;
  private readonly keychain: () => KeychainEntry | null;

  constructor(config: LocalSecretsConfig = {}) {
    this.directory =
      config.configDirectory ?? process.env.AGENTCORE_CONFIG_DIR ?? join(homedir(), ".agentcore");
    this.keychain = config.keychain ?? defaultKeychain;
  }

  async encrypt(env: Record<string, string>): Promise<Record<string, string>> {
    const pending = Object.entries(env).filter(
      ([name, value]) => isSensitiveKey(name) && value !== "" && !value.startsWith(ENC_PREFIX),
    );
    if (pending.length === 0) return env;
    const key = this.encryptionKey();
    return {
      ...env,
      ...Object.fromEntries(pending.map(([name, value]) => [name, encryptSecret(value, key)])),
    };
  }

  async decrypt(env: Record<string, string>): Promise<Record<string, string>> {
    if (!Object.values(env).some((value) => value.startsWith(ENC_PREFIX))) return env;
    const keys: Buffer[] = [];
    const decode = () =>
      Object.fromEntries(
        Object.entries(env).map(([name, value]) => [
          name,
          value.startsWith(ENC_PREFIX) ? decryptSecret(value, keys) : value,
        ]),
      );
    for (const key of this.candidateKeys()) {
      keys.push(key);
      try {
        return decode();
      } catch (error) {
        if (!(error instanceof ProjectStateError)) throw error;
      }
    }
    return decode();
  }

  private encryptionKey(): Buffer {
    if (this.key) return this.key;
    const path = join(this.directory, "secrets.key");
    try {
      let key = this.readKeyfile(path);
      if (!key) {
        const stored = this.keychainKey(true);
        if (stored) return (this.key = stored);
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        key = randomBytes(KEY_BYTES);
        try {
          writeFileSync(path, key, { mode: 0o600, flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          key = this.readKeyfile(path);
        }
      }
      if (!key) throw new Error("The encryption key disappeared during creation.");
      this.assertKeySize(key, path);
      if (process.platform !== "win32") chmodSync(path, 0o600);
      return (this.key = key);
    } catch (error) {
      if (error instanceof ProjectStateError) throw error;
      throw new FileWriteError(`Could not create or read the encryption key at ${path}.`, {
        cause: error,
      });
    }
  }

  private *candidateKeys(): Generator<Buffer> {
    let fileKey: Buffer | undefined;
    try {
      fileKey = this.readKeyfile(join(this.directory, "secrets.key"));
    } catch {
      fileKey = undefined;
    }
    if (fileKey?.length === KEY_BYTES) yield fileKey;
    const stored = this.keychainKey(false);
    if (stored && (fileKey === undefined || !stored.equals(fileKey))) yield stored;
  }

  private keychainKey(create: boolean): Buffer | null {
    try {
      const entry = this.keychain();
      if (!entry) return null;
      const password = entry.getPassword();
      if (password !== null) {
        const key = Buffer.from(password, "base64");
        return key.length === KEY_BYTES ? key : null;
      }
      if (!create) return null;
      entry.setPassword(randomBytes(KEY_BYTES).toString("base64"));
      const persisted = entry.getPassword();
      if (persisted === null) return null;
      const key = Buffer.from(persisted, "base64");
      return key.length === KEY_BYTES ? key : null;
    } catch {
      return null;
    }
  }

  private readKeyfile(path: string): Buffer | undefined {
    try {
      return readFileSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private assertKeySize(key: Buffer, path: string): void {
    if (key.length !== KEY_BYTES) {
      throw new ProjectStateError(
        `Encryption key file at ${path} is corrupt (expected ${KEY_BYTES} bytes, found ${key.length}). ` +
          "Restore the original key file or move it aside and re-add your credentials.",
      );
    }
  }
}
