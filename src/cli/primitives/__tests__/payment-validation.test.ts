import {
  stripWalletAuthPrefix,
  validateApiKeySecret,
  validateAuthorizationPrivateKey,
  validateWalletSecret,
} from '../payment-validation';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

// Realistic base64-encoded private keys for each curve, matching what the
// payment APIs expect. Computed once so the byte-length bands are exercised
// against real key sizes rather than arbitrary buffers.
const ed25519Pkcs8 = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'der' })
  .toString('base64'); // ~48 bytes
const p256Pkcs8 = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'der' })
  .toString('base64'); // ~138 bytes

describe('autoPayment CLI parsing', () => {
  function parseAutoPayment(value: string | boolean | undefined): boolean | undefined {
    if (value === undefined) return undefined;
    return !['false', 'no', '0', 'off'].includes(String(value).toLowerCase());
  }

  describe('falsy string values produce false', () => {
    it.each(['false', 'False', 'FALSE', 'no', 'No', 'NO', '0', 'off', 'Off', 'OFF'])(
      'parseAutoPayment("%s") returns false',
      val => {
        expect(parseAutoPayment(val)).toBe(false);
      }
    );
  });

  describe('truthy values produce true', () => {
    it.each(['true', 'True', 'TRUE', 'yes', '1', 'on', 'anything'])('parseAutoPayment("%s") returns true', val => {
      expect(parseAutoPayment(val)).toBe(true);
    });
  });

  it('boolean true passes through as true', () => {
    expect(parseAutoPayment(true)).toBe(true);
  });

  it('boolean false passes through as false', () => {
    expect(parseAutoPayment(false)).toBe(false);
  });

  it('undefined returns undefined', () => {
    expect(parseAutoPayment(undefined)).toBeUndefined();
  });
});

describe('defaultSpendLimit validation', () => {
  function validateSpendLimit(value: string): { valid: boolean } {
    const num = Number(value);
    if (Number.isNaN(num) || num < 0) return { valid: false };
    return { valid: true };
  }

  it('accepts "0"', () => expect(validateSpendLimit('0')).toEqual({ valid: true }));
  it('accepts "10.50"', () => expect(validateSpendLimit('10.50')).toEqual({ valid: true }));
  it('accepts large numbers', () => expect(validateSpendLimit('999999.99')).toEqual({ valid: true }));
  it('rejects negative values', () => expect(validateSpendLimit('-1')).toEqual({ valid: false }));
  it('rejects non-numeric strings', () => expect(validateSpendLimit('abc')).toEqual({ valid: false }));
  it('accepts empty string as 0 (Number("") === 0)', () => expect(validateSpendLimit('')).toEqual({ valid: true }));
});

describe('validateApiKeySecret (CoinbaseCDP — Ed25519)', () => {
  it('accepts a base64-encoded Ed25519 PKCS8 key (~48 bytes)', () => {
    expect(validateApiKeySecret(ed25519Pkcs8)).toBe(true);
  });

  it('accepts a 64-byte Coinbase seed+pubkey secret', () => {
    expect(validateApiKeySecret(Buffer.alloc(64, 0x41).toString('base64'))).toBe(true);
  });

  it('accepts a raw 32-byte Ed25519 seed', () => {
    expect(validateApiKeySecret(Buffer.alloc(32, 0x41).toString('base64'))).toBe(true);
  });

  it('rejects non-base64 input', () => {
    expect(validateApiKeySecret('not base64!')).toContain('Ed25519');
  });

  it('rejects a P-256 key (wrong curve — too long for Ed25519)', () => {
    const result = validateApiKeySecret(p256Pkcs8);
    expect(result).not.toBe(true);
    expect(result).toContain('length');
  });

  it('rejects a too-short key', () => {
    expect(validateApiKeySecret(Buffer.alloc(16, 0x41).toString('base64'))).not.toBe(true);
  });
});

describe('validateWalletSecret (CoinbaseCDP — EC P-256)', () => {
  it('accepts a base64-encoded P-256 PKCS8 key (~138 bytes)', () => {
    expect(validateWalletSecret(p256Pkcs8)).toBe(true);
  });

  it('rejects non-base64 input', () => {
    expect(validateWalletSecret('nope!')).toContain('P-256');
  });

  it('rejects an Ed25519 key (wrong curve — too short for P-256)', () => {
    expect(validateWalletSecret(ed25519Pkcs8)).not.toBe(true);
  });
});

describe('validateAuthorizationPrivateKey (StripePrivy — EC P-256)', () => {
  it('accepts a base64-encoded P-256 PKCS8 key', () => {
    expect(validateAuthorizationPrivateKey(p256Pkcs8)).toBe(true);
  });

  it('accepts a key with the wallet-auth: prefix', () => {
    expect(validateAuthorizationPrivateKey(`wallet-auth:${p256Pkcs8}`)).toBe(true);
  });

  it('rejects non-base64 input', () => {
    expect(validateAuthorizationPrivateKey('not-base64!')).toContain('base64');
  });

  it('rejects a key of the wrong length', () => {
    expect(validateAuthorizationPrivateKey('dGVzdA==')).toContain('length');
  });
});

describe('stripWalletAuthPrefix', () => {
  it('strips the wallet-auth: prefix', () => {
    expect(stripWalletAuthPrefix('wallet-auth:ABC')).toBe('ABC');
  });

  it('trims and leaves an unprefixed value', () => {
    expect(stripWalletAuthPrefix('  ABC  ')).toBe('ABC');
  });
});

describe('credential sanitization regex', () => {
  const REGEX =
    /("apiKeySecret"|"walletSecret"|"apiKeyId"|"appId"|"appSecret"|"authorizationPrivateKey"|"authorizationId")\s*:\s*"[^"]*"/g;

  function sanitize(body: string): string {
    return body.replace(REGEX, '$1:"[REDACTED]"').slice(0, 500);
  }

  it('redacts all 7 credential field names', () => {
    const body = JSON.stringify({
      apiKeyId: 'key-123',
      apiKeySecret: 'secret-456',
      walletSecret: 'wallet-789',
      appId: 'app-abc',
      appSecret: 'app-secret-def',
      authorizationPrivateKey: 'priv-key-ghi',
      authorizationId: 'auth-jkl',
    });
    const result = sanitize(body);
    expect(result).not.toContain('key-123');
    expect(result).not.toContain('secret-456');
    expect(result).not.toContain('wallet-789');
    expect(result).not.toContain('app-abc');
    expect(result).not.toContain('app-secret-def');
    expect(result).not.toContain('priv-key-ghi');
    expect(result).not.toContain('auth-jkl');
    expect(result).toContain('[REDACTED]');
  });

  it('preserves non-credential fields', () => {
    const body = JSON.stringify({ message: 'Not found', code: 'ResourceNotFoundException', apiKeySecret: 'leaked' });
    const result = sanitize(body);
    expect(result).toContain('Not found');
    expect(result).toContain('ResourceNotFoundException');
    expect(result).not.toContain('leaked');
  });

  it('truncates to 500 characters', () => {
    const longBody = '{"apiKeyId":"x"}'.repeat(100);
    expect(sanitize(longBody).length).toBeLessThanOrEqual(500);
  });
});
