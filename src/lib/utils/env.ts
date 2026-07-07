import { ENV_FILE } from '../constants';
import { findConfigRoot } from '../schemas/io/path-resolver';
import {
  ENC_PREFIX,
  decryptSecret,
  encryptSecret,
  isSensitiveKey,
  resolveCandidateKeys,
  resolveEncryptionKey,
} from '../secrets';
import { parse } from 'dotenv';
import { existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

/**
 * Get the path to agentcore/.env.local.
 * @param configRoot - Optional config root, defaults to finding it automatically
 */
export function getEnvPath(configRoot?: string): string {
  const root = configRoot ?? findConfigRoot();
  if (!root) throw new Error('Could not find agentcore directory');
  return join(root, ENV_FILE);
}

/** Escape and serialize an env record to dotenv `KEY="value"` lines. */
function serializeEnv(env: Record<string, string>): string {
  const lines = Object.entries(env)
    .map(([k, v]) => {
      if (v === undefined || v === null) return '';
      if (!/^[a-z_][a-z0-9_]*$/i.test(k)) throw new Error(`Invalid env key: ${k}`);
      const val = String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
      return `${k}="${val}"`;
    })
    .filter(Boolean);
  return lines.length > 0 ? lines.join('\n') + '\n' : '';
}

/**
 * Read agentcore/.env.local. Sensitive values stored as `enc:v1:` envelopes are
 * decrypted transparently; legacy plaintext values are returned as-is.
 */
export async function readEnvFile(configRoot?: string): Promise<Record<string, string>> {
  const path = getEnvPath(configRoot);
  if (!existsSync(path)) return {};
  const parsed = parse(await readFile(path, 'utf-8'));
  const entries = Object.entries(parsed);
  if (!entries.some(([, v]) => v.startsWith(ENC_PREFIX))) return parsed;
  // Try every available key (keychain + keyfile) so a value sealed by either
  // source decrypts even if the active source differs from the one that wrote it.
  const keys = await resolveCandidateKeys();
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    out[k] = v.startsWith(ENC_PREFIX) ? decryptSecret(v, keys) : v;
  }
  return out;
}

/**
 * Get a single value from agentcore/.env.local.
 */
export async function getEnvVar(key: string, configRoot?: string): Promise<string | undefined> {
  return (await readEnvFile(configRoot))[key];
}

/** Encrypt sensitive plaintext values; leave non-sensitive and already-encrypted values unchanged. */
async function encryptSensitive(env: Record<string, string>): Promise<Record<string, string>> {
  const needsEncryption = Object.entries(env).some(
    ([k, v]) => isSensitiveKey(k) && v !== undefined && v !== null && !String(v).startsWith(ENC_PREFIX)
  );
  if (!needsEncryption) return env;
  const key = await resolveEncryptionKey();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] =
      isSensitiveKey(k) && v !== undefined && v !== null && !String(v).startsWith(ENC_PREFIX)
        ? encryptSecret(String(v), key)
        : v;
  }
  return out;
}

/**
 * Write to agentcore/.env.local. Merges with existing values by default and
 * encrypts sensitive values at rest.
 */
export async function writeEnvFile(updates: Record<string, string>, configRoot?: string, merge = true): Promise<void> {
  const path = getEnvPath(configRoot);
  // Merge against the RAW on-disk values (still encrypted) so we never decrypt
  // then re-encrypt unchanged secrets; encryptSensitive skips enc:v1: values.
  const current = merge && existsSync(path) ? parse(await readFile(path, 'utf-8')) : {};
  const env = await encryptSensitive({ ...current, ...updates });
  await writeFile(path, serializeEnv(env));
}

/**
 * Set a single value in agentcore/.env.local.
 */
export async function setEnvVar(key: string, value: string, configRoot?: string): Promise<void> {
  await writeEnvFile({ [key]: value }, configRoot);
}

/**
 * Remove keys from agentcore/.env.local.
 */
export async function removeEnvVars(keys: string[], configRoot?: string): Promise<void> {
  const path = getEnvPath(configRoot);
  if (!existsSync(path)) return;
  const current = parse(await readFile(path, 'utf-8')); // raw (encrypted) values
  for (const key of keys) delete current[key];
  const env = await encryptSensitive(current); // re-encrypts any legacy plaintext among the remainder
  await writeFile(path, serializeEnv(env));
}
