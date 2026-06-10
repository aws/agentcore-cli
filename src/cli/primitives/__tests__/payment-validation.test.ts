import { describe, expect, it } from 'vitest';

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

describe('base64 key validation', () => {
  const BASE64_REGEX = /^[A-Za-z0-9+/]+=*$/;

  function validateBase64Key(key: string): { valid: boolean; error?: string } {
    const trimmed = key.trim();
    if (!BASE64_REGEX.test(trimmed)) return { valid: false, error: 'not base64' };
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length < 100 || decoded.length > 200) return { valid: false, error: 'unexpected length' };
    return { valid: true };
  }

  it('rejects non-base64 characters', () => {
    expect(validateBase64Key('not-base64!').valid).toBe(false);
  });

  it('rejects too-short decoded key (< 100 bytes)', () => {
    expect(validateBase64Key('dGVzdA==').valid).toBe(false);
  });

  it('rejects too-long decoded key (> 200 bytes)', () => {
    const buf = Buffer.alloc(201, 0x42);
    expect(validateBase64Key(buf.toString('base64')).valid).toBe(false);
  });

  it('accepts decoded key of exactly 100 bytes', () => {
    const buf = Buffer.alloc(100, 0x41);
    expect(validateBase64Key(buf.toString('base64')).valid).toBe(true);
  });

  it('accepts decoded key of exactly 200 bytes', () => {
    const buf = Buffer.alloc(200, 0x41);
    expect(validateBase64Key(buf.toString('base64')).valid).toBe(true);
  });

  it('accepts a valid ~138 byte key', () => {
    const key =
      'RkFLRV9TVFJJUEVfUFJJVllfVEVTVF9LRVlfQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQQ==';
    expect(validateBase64Key(key).valid).toBe(true);
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
