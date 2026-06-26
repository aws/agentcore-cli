import { SecretDecryptionError } from '../errors/types';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const ENC_PREFIX = 'enc:v1:';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Encrypt a plaintext secret to an `enc:v1:` envelope: base64(IV || tag || ciphertext). */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENC_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Attempt to decrypt with a single key. Returns the plaintext or null on any failure (does NOT throw). */
function tryDecrypt(token: string, key: Buffer): string | null {
  try {
    const raw = Buffer.from(token.slice(ENC_PREFIX.length), 'base64');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  } catch {
    return null;
  }
}

/**
 * Decrypt an `enc:v1:` envelope, trying each candidate key in turn. A value may
 * have been sealed by the OS keychain or the keyfile; trying all available keys
 * means a value still decrypts even if the active key source differs from the
 * one that wrote it (e.g. AGENTCORE_DISABLE_KEYCHAIN toggled between add and a
 * later read). Throws SecretDecryptionError only if no key works.
 */
export function decryptSecret(token: string, keys: Buffer | Buffer[]): string {
  if (!token.startsWith(ENC_PREFIX)) {
    throw new SecretDecryptionError('Value is not an encrypted secret envelope.');
  }
  const candidates = Array.isArray(keys) ? keys : [keys];
  for (const key of candidates) {
    const plaintext = tryDecrypt(token, key);
    if (plaintext !== null) return plaintext;
  }
  throw new SecretDecryptionError(
    'Could not decrypt a stored secret in agentcore/.env.local — the encryption key may be missing or changed. Re-add the credential'
  );
}
