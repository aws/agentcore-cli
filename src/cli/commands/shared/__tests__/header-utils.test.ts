import {
  normalizeHeaderName,
  parseAndNormalizeHeaders,
  parseHeaderFlag,
  parseHeaderFlags,
  validateHeaderAllowlist,
} from '../header-utils';
import { describe, expect, it } from 'vitest';

describe('normalizeHeaderName', () => {
  it('returns "Authorization" as-is', () => {
    expect(normalizeHeaderName('Authorization')).toBe('Authorization');
  });

  it('normalizes case-insensitive "authorization" to "Authorization"', () => {
    expect(normalizeHeaderName('authorization')).toBe('Authorization');
    expect(normalizeHeaderName('AUTHORIZATION')).toBe('Authorization');
    expect(normalizeHeaderName('AuThOrIzAtIoN')).toBe('Authorization');
  });

  it('returns full header name with canonical prefix when prefix already present', () => {
    const fullHeader = 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader';
    expect(normalizeHeaderName(fullHeader)).toBe(fullHeader);
  });

  it('normalizes prefix casing to canonical form', () => {
    expect(normalizeHeaderName('x-amzn-bedrock-agentcore-runtime-custom-MyHeader')).toBe(
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader'
    );
    expect(normalizeHeaderName('X-AMZN-BEDROCK-AGENTCORE-RUNTIME-CUSTOM-MyHeader')).toBe(
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader'
    );
  });

  it('preserves arbitrary header names without auto-prefixing', () => {
    expect(normalizeHeaderName('MyHeader')).toBe('MyHeader');
    expect(normalizeHeaderName('My-Custom-Header')).toBe('My-Custom-Header');
    expect(normalizeHeaderName('X-Custom-Signature')).toBe('X-Custom-Signature');
    expect(normalizeHeaderName('X-Api-Key')).toBe('X-Api-Key');
  });
});

describe('parseAndNormalizeHeaders', () => {
  it('returns empty array for empty string', () => {
    expect(parseAndNormalizeHeaders('')).toEqual([]);
  });

  it('returns empty array for whitespace-only', () => {
    expect(parseAndNormalizeHeaders('  ,  , ')).toEqual([]);
  });

  it('splits comma-separated and normalizes', () => {
    const result = parseAndNormalizeHeaders('MyHeader, authorization, Another-Header');
    expect(result).toEqual(['MyHeader', 'Authorization', 'Another-Header']);
  });

  it('deduplicates after normalization (case-insensitive)', () => {
    const result = parseAndNormalizeHeaders('MyHeader, myheader, MYHEADER');
    expect(result).toEqual(['MyHeader']);
  });

  it('deduplicates the AgentCore custom prefix variations', () => {
    const result = parseAndNormalizeHeaders(
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader, x-amzn-bedrock-agentcore-runtime-custom-MyHeader'
    );
    expect(result).toEqual(['X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader']);
  });

  it('deduplicates case-insensitive Authorization', () => {
    const result = parseAndNormalizeHeaders('authorization, Authorization, AUTHORIZATION');
    expect(result).toEqual(['Authorization']);
  });

  it('trims whitespace around values', () => {
    const result = parseAndNormalizeHeaders('  MyHeader  ,  authorization  ,  Another-Header  ');
    expect(result).toEqual(['MyHeader', 'Authorization', 'Another-Header']);
  });
});

describe('validateHeaderAllowlist', () => {
  it('returns success for empty input', () => {
    expect(validateHeaderAllowlist('')).toEqual({ success: true });
    expect(validateHeaderAllowlist('   ')).toEqual({ success: true });
  });

  it('accepts arbitrary custom headers (no longer requires the AgentCore prefix)', () => {
    expect(validateHeaderAllowlist('MyHeader')).toEqual({ success: true });
    expect(validateHeaderAllowlist('X-Custom-Signature')).toEqual({ success: true });
    expect(validateHeaderAllowlist('X-Api-Key')).toEqual({ success: true });
    expect(validateHeaderAllowlist('Some_Header_With_Underscores')).toEqual({ success: true });
  });

  it('returns success for valid full AgentCore custom header name', () => {
    expect(validateHeaderAllowlist('X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader')).toEqual({ success: true });
  });

  it('returns success for "Authorization"', () => {
    expect(validateHeaderAllowlist('Authorization')).toEqual({ success: true });
    expect(validateHeaderAllowlist('authorization')).toEqual({ success: true });
  });

  it('returns success for mixed valid headers', () => {
    expect(
      validateHeaderAllowlist('Authorization, X-Custom-Signature, X-Amzn-Bedrock-AgentCore-Runtime-Custom-Another')
    ).toEqual({ success: true });
  });

  it('returns error when exceeding max 20 headers', () => {
    const headers = Array.from({ length: 21 }, (_, i) => `Header${i}`).join(', ');
    const result = validateHeaderAllowlist(headers);
    expect(result.success).toBe(false);
    expect(result.error).toContain('20');
  });

  it('returns success for exactly 20 headers', () => {
    const headers = Array.from({ length: 20 }, (_, i) => `Header${i}`).join(', ');
    expect(validateHeaderAllowlist(headers)).toEqual({ success: true });
  });

  it('returns error for header names containing whitespace', () => {
    const result = validateHeaderAllowlist('My Header');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid header name');
  });

  it('returns error for header names with special characters', () => {
    const result = validateHeaderAllowlist('My@Header');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid header name');
  });

  it('rejects restricted headers (Cookie, Host, Accept, Content-Type, etc.)', () => {
    for (const restricted of ['Cookie', 'Host', 'Accept', 'Content-Type', 'User-Agent', 'Connection']) {
      const result = validateHeaderAllowlist(restricted);
      expect(result.success, `expected "${restricted}" to be rejected`).toBe(false);
      expect(result.error).toMatch(/restricted/i);
    }
  });

  it('rejects restricted headers case-insensitively', () => {
    const result = validateHeaderAllowlist('cookie');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/restricted/i);
  });

  it('rejects headers starting with x-amz-', () => {
    const result = validateHeaderAllowlist('X-Amz-Date');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/x-amz-/i);
  });

  it('rejects headers starting with x-amzn- that are not the AgentCore custom prefix', () => {
    const result = validateHeaderAllowlist('X-Amzn-Foo');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/x-amzn-/i);
  });

  it('rejects duplicate headers (case-insensitive)', () => {
    const result = validateHeaderAllowlist('MyHeader, myheader');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/[Dd]uplicate/);
  });
});

describe('parseHeaderFlag', () => {
  it('parses "Key: Value" format', () => {
    expect(parseHeaderFlag('MyHeader: some-value')).toEqual({
      name: 'MyHeader',
      value: 'some-value',
    });
  });

  it('parses "Key:Value" format without space', () => {
    expect(parseHeaderFlag('MyHeader:some-value')).toEqual({
      name: 'MyHeader',
      value: 'some-value',
    });
  });

  it('handles values containing colons', () => {
    expect(parseHeaderFlag('Authorization: Bearer token:with:colons')).toEqual({
      name: 'Authorization',
      value: 'Bearer token:with:colons',
    });
  });

  it('normalizes Authorization casing', () => {
    expect(parseHeaderFlag('authorization: token')).toEqual({
      name: 'Authorization',
      value: 'token',
    });
  });

  it('preserves case for arbitrary headers (no auto-prefixing)', () => {
    expect(parseHeaderFlag('X-Custom-Signature: abc123')).toEqual({
      name: 'X-Custom-Signature',
      value: 'abc123',
    });
  });

  it('returns null for missing colon', () => {
    expect(parseHeaderFlag('no-colon-here')).toBeNull();
  });

  it('returns null for empty key', () => {
    expect(parseHeaderFlag(': value')).toBeNull();
  });

  it('trims whitespace from key and value', () => {
    expect(parseHeaderFlag('  MyHeader  :  some-value  ')).toEqual({
      name: 'MyHeader',
      value: 'some-value',
    });
  });
});

describe('parseHeaderFlags', () => {
  it('parses multiple headers', () => {
    const result = parseHeaderFlags(['MyHeader: value1', 'Authorization: Bearer token']);
    expect(result).toEqual({
      MyHeader: 'value1',
      Authorization: 'Bearer token',
    });
  });

  it('returns empty object for empty array', () => {
    expect(parseHeaderFlags([])).toEqual({});
  });

  it('last value wins for duplicate keys', () => {
    const result = parseHeaderFlags(['MyHeader: first', 'MyHeader: second']);
    expect(result).toEqual({
      MyHeader: 'second',
    });
  });

  it('throws on invalid format', () => {
    expect(() => parseHeaderFlags(['invalid-no-colon'])).toThrow('Invalid header format');
  });
});
