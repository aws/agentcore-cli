import { SecretEncryptionError } from '../errors/types';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY_BYTES = 32;
const KEYCHAIN_SERVICE = 'aws-agentcore';
const KEYCHAIN_ACCOUNT = 'env-local-secret-key';

let cachedKey: Buffer | null = null;

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
}

interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry;
}

/** Keychain is opt-out (headless/CI) and best-effort; any failure falls through to the keyfile. */
async function tryKeychainKey(): Promise<Buffer | null> {
  if (process.env.AGENTCORE_DISABLE_KEYCHAIN === '1') return null;
  try {
    // Optional native dependency — dynamic import so a missing/unbuildable
    // module degrades to the keyfile instead of failing the CLI.
    const { Entry } = (await import('@napi-rs/keyring')) as KeyringModule;
    const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    try {
      const existing = entry.getPassword();
      if (existing) return Buffer.from(existing, 'base64');
    } catch {
      // no stored password yet
    }
    const key = randomBytes(KEY_BYTES);
    entry.setPassword(key.toString('base64'));
    return key;
  } catch {
    return null;
  }
}

function resolveConfigDir(): string {
  return process.env.AGENTCORE_CONFIG_DIR ?? join(homedir(), '.agentcore');
}

function keyfilePath(): string {
  return join(resolveConfigDir(), 'secrets.key');
}

function keyfileKey(): Buffer {
  const path = keyfilePath();
  try {
    if (existsSync(path)) {
      const key = readFileSync(path);
      if (key.length === KEY_BYTES) return key;
    }
    mkdirSync(resolveConfigDir(), { recursive: true });
    const key = randomBytes(KEY_BYTES);
    writeFileSync(path, key, { mode: 0o600 });
    return key;
  } catch (err) {
    throw new SecretEncryptionError(`Could not create or read the machine encryption key at ${path}.`, {
      cause: err instanceof Error ? err : undefined,
    });
  }
}

/** Resolve the 32-byte machine-local encryption key: keychain first, keyfile fallback. */
export async function resolveEncryptionKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  const fromKeychain = await tryKeychainKey();
  cachedKey = fromKeychain ?? keyfileKey();
  return cachedKey;
}

/** Reset the per-process key cache. Only for use in tests. */
export function __resetKeyCacheForTests(): void {
  cachedKey = null;
}
