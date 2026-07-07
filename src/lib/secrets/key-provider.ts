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
    // Re-read after writing: if a concurrent process stored a different key
    // between our getPassword() and setPassword(), the keychain now holds
    // theirs — trust the persisted value, not our local one, so both processes
    // converge on the same key.
    try {
      const persisted = entry.getPassword();
      if (persisted) return Buffer.from(persisted, 'base64');
    } catch {
      // fall through to the freshly-generated key
    }
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

/** A keyfile that exists but isn't KEY_BYTES long is corrupt — never overwrite it. */
function assertKeyfileSize(key: Buffer, path: string): Buffer {
  if (key.length === KEY_BYTES) return key;
  throw new SecretEncryptionError(
    `Encryption key file at ${path} is corrupt (expected ${KEY_BYTES} bytes, found ${key.length}). ` +
      `Move it aside and re-add your credentials, or restore the original key file`
  );
}

function keyfileKey(): Buffer {
  const path = keyfilePath();
  try {
    if (existsSync(path)) {
      // A wrong-sized existing file is corruption, NOT a cue to mint a new key:
      // overwriting it would permanently orphan every secret sealed with the
      // real key. Fail loud instead.
      return assertKeyfileSize(readFileSync(path), path);
    }
    mkdirSync(resolveConfigDir(), { recursive: true });
    const key = randomBytes(KEY_BYTES);
    try {
      // `wx` fails if the file already exists, making first-time creation
      // last-writer-safe: if a concurrent process created it between the
      // existsSync check and here, re-read theirs instead of clobbering it.
      writeFileSync(path, key, { mode: 0o600, flag: 'wx' });
      return key;
    } catch (writeErr) {
      if ((writeErr as NodeJS.ErrnoException).code === 'EEXIST') {
        return assertKeyfileSize(readFileSync(path), path);
      }
      throw writeErr;
    }
  } catch (err) {
    if (err instanceof SecretEncryptionError) throw err;
    throw new SecretEncryptionError(`Could not create or read the machine encryption key at ${path}.`, {
      cause: err instanceof Error ? err : undefined,
    });
  }
}

/** Read the keyfile key WITHOUT creating one if absent (read-only; returns null when missing). */
function readKeyfileKeyIfPresent(): Buffer | null {
  try {
    const path = keyfilePath();
    if (existsSync(path)) {
      const key = readFileSync(path);
      if (key.length === KEY_BYTES) return key;
    }
  } catch {
    // unreadable keyfile — treat as absent
  }
  return null;
}

/** Read the keychain key WITHOUT creating one if absent (returns null when unavailable/missing). */
async function readKeychainKeyIfPresent(): Promise<Buffer | null> {
  if (process.env.AGENTCORE_DISABLE_KEYCHAIN === '1') return null;
  try {
    const { Entry } = (await import('@napi-rs/keyring')) as KeyringModule;
    const existing = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).getPassword();
    return existing ? Buffer.from(existing, 'base64') : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the single key used to ENCRYPT new values: keychain first, keyfile
 * fallback. Creates a key if none exists yet.
 */
export async function resolveEncryptionKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  const fromKeychain = await tryKeychainKey();
  cachedKey = fromKeychain ?? keyfileKey();
  return cachedKey;
}

/**
 * Resolve ALL candidate keys for DECRYPTION, newest-intent first. A stored
 * value may have been sealed by the keychain on one run and the keyfile on
 * another (e.g. AGENTCORE_DISABLE_KEYCHAIN toggled); trying every available key
 * lets a value decrypt regardless of which source is currently active. Read-only
 * — never creates a key. May be empty if no key material exists at all.
 */
export async function resolveCandidateKeys(): Promise<Buffer[]> {
  const keys: Buffer[] = [];
  const fromKeychain = await readKeychainKeyIfPresent();
  if (fromKeychain) keys.push(fromKeychain);
  const fromKeyfile = readKeyfileKeyIfPresent();
  if (fromKeyfile && !keys.some(k => k.equals(fromKeyfile))) keys.push(fromKeyfile);
  return keys;
}

/** Reset the per-process key cache. Only for use in tests. */
export function __resetKeyCacheForTests(): void {
  cachedKey = null;
}
