import { redactSecrets, rethrowWithContext, sanitizeErrorBody } from '../agentcore-payments';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('redactSecrets', () => {
  it('replaces literal secret values with [REDACTED]', () => {
    const text = 'key=sk_live_abc123 and wallet=w_secret_456';
    const result = redactSecrets(text, ['sk_live_abc123', 'w_secret_456']);
    expect(result).toBe('key=[REDACTED] and wallet=[REDACTED]');
  });

  it('handles secrets nested in JSON', () => {
    const body = JSON.stringify({ nested: { deep: { value: 'my-secret-key' } } });
    expect(redactSecrets(body, ['my-secret-key'])).not.toContain('my-secret-key');
    expect(redactSecrets(body, ['my-secret-key'])).toContain('[REDACTED]');
  });

  it('handles snake_cased server echo of secrets', () => {
    const body = '{"api_key_secret": "sk_live_abc123", "error": "invalid api_key_secret: sk_live_abc123"}';
    const result = redactSecrets(body, ['sk_live_abc123']);
    expect(result).not.toContain('sk_live_abc123');
    expect(result.match(/\[REDACTED\]/g)?.length).toBe(2);
  });

  it('handles secrets embedded in free-text messages', () => {
    const body = 'Error: The provided key "super_secret_value" is invalid for account xyz';
    expect(redactSecrets(body, ['super_secret_value'])).toBe(
      'Error: The provided key "[REDACTED]" is invalid for account xyz'
    );
  });

  it('does not crash with empty secrets iterable', () => {
    expect(redactSecrets('hello world', [])).toBe('hello world');
  });

  it('does not crash with undefined secrets', () => {
    expect(redactSecrets('hello world', undefined)).toBe('hello world');
  });

  it('skips empty string secrets without infinite loop', () => {
    expect(redactSecrets('hello world', ['', 'world'])).toBe('hello [REDACTED]');
  });
});

describe('sanitizeErrorBody', () => {
  let originalDebug: string | undefined;

  beforeEach(() => {
    originalDebug = process.env.DEBUG;
  });

  afterEach(() => {
    if (originalDebug !== undefined) process.env.DEBUG = originalDebug;
    else delete process.env.DEBUG;
  });

  it('returns empty string for empty body regardless of DEBUG', () => {
    process.env.DEBUG = '1';
    expect(sanitizeErrorBody('', ['secret'])).toBe('');
    delete process.env.DEBUG;
    expect(sanitizeErrorBody('', ['secret'])).toBe('');
  });

  describe('without DEBUG', () => {
    beforeEach(() => {
      delete process.env.DEBUG;
    });

    it('includes parsed code from response body', () => {
      const body = JSON.stringify({ code: 'ValidationException', message: 'name is required' });
      const result = sanitizeErrorBody(body, []);
      expect(result).toContain('ValidationException');
    });

    it('includes parsed __type from response body', () => {
      const body = JSON.stringify({ __type: 'ThrottlingException', message: 'rate exceeded' });
      const result = sanitizeErrorBody(body, []);
      expect(result).toContain('ThrottlingException');
    });

    it('includes redacted server message', () => {
      const body = JSON.stringify({
        code: 'ValidationException',
        message: 'Invalid key: sk_live_abc123',
      });
      const result = sanitizeErrorBody(body, ['sk_live_abc123']);
      expect(result).toContain('ValidationException');
      expect(result).toContain('Invalid key: [REDACTED]');
      expect(result).not.toContain('sk_live_abc123');
    });

    it('handles Message field (capital M)', () => {
      const body = JSON.stringify({ code: 'InternalError', Message: 'something went wrong' });
      const result = sanitizeErrorBody(body, []);
      expect(result).toContain('something went wrong');
    });

    it('handles errorMessage field', () => {
      const body = JSON.stringify({ __type: 'ServiceException', errorMessage: 'oops' });
      const result = sanitizeErrorBody(body, []);
      expect(result).toContain('oops');
    });

    it('does not include the raw body', () => {
      const body = JSON.stringify({ code: 'Err', message: 'msg', extra: 'data' });
      const result = sanitizeErrorBody(body, []);
      expect(result).not.toContain('"extra"');
    });

    it('returns empty string for non-JSON body with no parseable fields', () => {
      const result = sanitizeErrorBody('Internal Server Error', []);
      expect(result).toBe('');
    });
  });

  describe('with DEBUG', () => {
    beforeEach(() => {
      process.env.DEBUG = '1';
    });

    it('includes full redacted body', () => {
      const body = JSON.stringify({
        code: 'ValidationException',
        message: 'bad key: sk_live_abc123',
        detail: { apiKeySecret: 'sk_live_abc123' },
      });
      const result = sanitizeErrorBody(body, ['sk_live_abc123']);
      expect(result).toContain('ValidationException');
      expect(result).toContain('bad key: [REDACTED]');
      expect(result).not.toContain('sk_live_abc123');
    });

    it('caps raw body at 500 chars after redaction', () => {
      const body = JSON.stringify({ message: 'x'.repeat(600) });
      const result = sanitizeErrorBody(body, []);
      const parts = result.split(' — ');
      const rawBodyPart = parts[parts.length - 1]!;
      expect(rawBodyPart.length).toBeLessThanOrEqual(500);
    });

    it('redacts secrets that straddle the 500-char boundary', () => {
      const prefix = 'a'.repeat(495);
      const secret = 'SECRET_VALUE_HERE';
      const body = JSON.stringify({ data: prefix + secret });
      const result = sanitizeErrorBody(body, [secret]);
      expect(result).not.toContain(secret);
    });

    it('includes non-JSON body in debug excerpt', () => {
      const result = sanitizeErrorBody('raw server error text', []);
      expect(result).toContain('raw server error text');
    });
  });
});

describe('rethrowWithContext', () => {
  it('preserves .code from the inner error', () => {
    const inner = new Error('something failed') as Error & { code?: string };
    inner.code = 'ValidationException';
    const wrapped = rethrowWithContext('Create failed', inner);
    expect(wrapped.code).toBe('ValidationException');
    expect(wrapped.message).toBe('Create failed: something failed');
  });

  it('works with non-Error values', () => {
    const wrapped = rethrowWithContext('Operation failed', 'string error');
    expect(wrapped.message).toBe('Operation failed: string error');
    expect(wrapped.code).toBeUndefined();
  });

  it('does not set .code when inner error has no code', () => {
    const wrapped = rethrowWithContext('prefix', new Error('inner'));
    expect(wrapped.code).toBeUndefined();
  });

  it('ignores non-string code values', () => {
    const inner = { message: 'hi', code: 42 };
    const wrapped = rethrowWithContext('prefix', inner);
    expect(wrapped.code).toBeUndefined();
  });
});
