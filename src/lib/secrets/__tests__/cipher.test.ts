import { ENC_PREFIX, decryptSecret, encryptSecret } from '../cipher';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const KEY = randomBytes(32);

describe('cipher', () => {
  it('round-trips a secret', () => {
    const token = encryptSecret('super-secret-value', KEY);
    expect(token.startsWith(ENC_PREFIX)).toBe(true);
    expect(token).not.toContain('super-secret-value');
    expect(decryptSecret(token, KEY)).toBe('super-secret-value');
  });

  it('produces a distinct token each call (random IV)', () => {
    expect(encryptSecret('x', KEY)).not.toBe(encryptSecret('x', KEY));
  });

  it('throws SecretDecryptionError on a tampered token', () => {
    const token = encryptSecret('value', KEY);
    const tampered = token.slice(0, -2) + (token.endsWith('A') ? 'B' : 'A');
    expect(() => decryptSecret(tampered, KEY)).toThrow(/decrypt/i);
  });

  it('throws SecretDecryptionError on a wrong key', () => {
    const token = encryptSecret('value', KEY);
    expect(() => decryptSecret(token, randomBytes(32))).toThrow(/decrypt/i);
  });

  it('throws on a non-enc token', () => {
    expect(() => decryptSecret('plaintext', KEY)).toThrow();
  });

  it('decrypts when the correct key is among multiple candidates (order-independent)', () => {
    const token = encryptSecret('multi-key-secret', KEY);
    const wrong = randomBytes(32);
    expect(decryptSecret(token, [wrong, KEY])).toBe('multi-key-secret');
    expect(decryptSecret(token, [KEY, wrong])).toBe('multi-key-secret');
  });

  it('throws when NO candidate key works', () => {
    const token = encryptSecret('value', KEY);
    expect(() => decryptSecret(token, [randomBytes(32), randomBytes(32)])).toThrow(/decrypt/i);
  });

  it('throws on an empty candidate list', () => {
    const token = encryptSecret('value', KEY);
    expect(() => decryptSecret(token, [])).toThrow(/decrypt/i);
  });

  it('decrypt-failure message has no double-period when wrapped by a caller', () => {
    const token = encryptSecret('value', KEY);
    try {
      decryptSecret(token, randomBytes(32));
      throw new Error('should have thrown');
    } catch (err) {
      // The message must not end in a period, so a wrapping `${msg}.` reads cleanly.
      expect((err as Error).message).not.toMatch(/\.$/);
      expect((err as Error).message).toContain('Re-add the credential');
    }
  });
});
