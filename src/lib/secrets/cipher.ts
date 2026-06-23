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

/** Decrypt an `enc:v1:` envelope produced by encryptSecret. Throws SecretDecryptionError on any failure. */
export function decryptSecret(token: string, key: Buffer): string {
  if (!token.startsWith(ENC_PREFIX)) {
    throw new SecretDecryptionError('Value is not an encrypted secret envelope.');
  }
  try {
    const raw = Buffer.from(token.slice(ENC_PREFIX.length), 'base64');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  } catch (err) {
    throw new SecretDecryptionError(
      'Could not decrypt a stored secret in agentcore/.env.local — the encryption key may be missing or changed. Re-add the credential.',
      { cause: err instanceof Error ? err : undefined }
    );
  }
}
