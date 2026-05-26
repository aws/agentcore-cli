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

  it('passes through X- prefixed headers unchanged', () => {
    expect(normalizeHeaderName('X-Api-Key')).toBe('X-Api-Key');
    expect(normalizeHeaderName('X-Custom-Signature')).toBe('X-Custom-Signature');
    expect(normalizeHeaderName('X-Request-Id')).toBe('X-Request-Id');
  });

  it('canonicalizes Runtime-Custom- prefix casing but preserves suffix as-typed', () => {
    expect(normalizeHeaderName('x-amzn-bedrock-agentcore-runtime-custom-myheader')).toBe(
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-myheader'
    );
    expect(normalizeHeaderName('X-AMZN-BEDROCK-AGENTCORE-RUNTIME-CUSTOM-MyHeader')).toBe(
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader'
    );
  });

  it('auto-prefixes a bare suffix like "MyHeader" (no X- prefix, backward compat)', () => {
    expect(normalizeHeaderName('MyHeader')).toBe('X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader');
  });

  it('auto-prefixes suffix with hyphens like "My-Custom-Header" (no X- prefix)', () => {
    expect(normalizeHeaderName('My-Custom-Header')).toBe('X-Amzn-Bedrock-AgentCore-Runtime-Custom-My-Custom-Header');
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
    expect(result).toEqual([
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader',
      'Authorization',
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Another-Header',
    ]);
  });

  it('passes through X- prefixed headers without auto-prefixing', () => {
    const result = parseAndNormalizeHeaders('X-Api-Key, X-Custom-Signature, authorization');
    expect(result).toEqual(['X-Api-Key', 'X-Custom-Signature', 'Authorization']);
  });

  it('deduplicates after normalization', () => {
    const result = parseAndNormalizeHeaders('MyHeader, X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader');
    expect(result).toEqual(['X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader']);
  });

  it('deduplicates case-insensitive Authorization', () => {
    const result = parseAndNormalizeHeaders('authorization, Authorization, AUTHORIZATION');
    expect(result).toEqual(['Authorization']);
  });

  it('deduplicates case-insensitively for X- headers', () => {
    const result = parseAndNormalizeHeaders('X-Api-Key, x-api-key');
    expect(result).toEqual(['X-Api-Key']);
  });

  it('trims whitespace around values', () => {
    const result = parseAndNormalizeHeaders('  MyHeader  ,  authorization  ,  X-Api-Key  ');
    expect(result).toEqual(['X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader', 'Authorization', 'X-Api-Key']);
  });
});

describe('validateHeaderAllowlist', () => {
  it('returns success for empty input', () => {
    expect(validateHeaderAllowlist('')).toEqual({ success: true });
    expect(validateHeaderAllowlist('   ')).toEqual({ success: true });
  });

  it('returns success for valid custom header suffix', () => {
    expect(validateHeaderAllowlist('MyHeader')).toEqual({ success: true });
  });

  it('returns success for valid full header name', () => {
    expect(validateHeaderAllowlist('X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader')).toEqual({ success: true });
  });

  it('returns success for "Authorization"', () => {
    expect(validateHeaderAllowlist('Authorization')).toEqual({ success: true });
    expect(validateHeaderAllowlist('authorization')).toEqual({ success: true });
  });

  it('returns success for X- prefixed headers from AWS docs', () => {
    expect(validateHeaderAllowlist('X-Api-Key')).toEqual({ success: true });
    expect(validateHeaderAllowlist('X-Custom-Signature')).toEqual({ success: true });
  });

  it('returns success for mixed valid headers', () => {
    expect(validateHeaderAllowlist('Authorization, X-Api-Key, X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId')).toEqual(
      { success: true }
    );
  });

  it('returns success for headers with underscores', () => {
    expect(validateHeaderAllowlist('X-My_Custom_Header')).toEqual({ success: true });
  });

  it('returns error for x-amz- prefixed headers', () => {
    const result = validateHeaderAllowlist('x-amz-security-token');
    expect(result.success).toBe(false);
    expect(result.error).toContain('reserved for AWS request signing');
  });

  it('returns error for x-amzn- prefixed headers (not Runtime-Custom-)', () => {
    const result = validateHeaderAllowlist('x-amzn-trace-id');
    expect(result.success).toBe(false);
    expect(result.error).toContain('x-amzn-');
  });

  it('returns success for X-Amzn-Bedrock-AgentCore-Runtime-Custom- headers', () => {
    expect(validateHeaderAllowlist('X-Amzn-Bedrock-AgentCore-Runtime-Custom-UserId')).toEqual({ success: true });
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
    expect(result.error).toContain('must contain only');
  });

  it('returns error for header names with special characters', () => {
    const result = validateHeaderAllowlist('My@Header');
    expect(result.success).toBe(false);
    expect(result.error).toContain('must contain only');
  });

  it('returns error for header with dots', () => {
    const result = validateHeaderAllowlist('My.Header');
    expect(result.success).toBe(false);
    expect(result.error).toContain('must contain only');
  });
});

describe('parseHeaderFlag', () => {
  it('parses "Key: Value" format', () => {
    expect(parseHeaderFlag('MyHeader: some-value')).toEqual({
      name: 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader',
      value: 'some-value',
    });
  });

  it('parses X- prefixed header without auto-prefixing', () => {
    expect(parseHeaderFlag('X-Api-Key: my-key')).toEqual({
      name: 'X-Api-Key',
      value: 'my-key',
    });
  });

  it('parses "Key:Value" format without space', () => {
    expect(parseHeaderFlag('MyHeader:some-value')).toEqual({
      name: 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader',
      value: 'some-value',
    });
  });

  it('handles values containing colons', () => {
    expect(parseHeaderFlag('Authorization: Bearer token:with:colons')).toEqual({
      name: 'Authorization',
      value: 'Bearer token:with:colons',
    });
  });

  it('normalizes header names', () => {
    expect(parseHeaderFlag('authorization: token')).toEqual({
      name: 'Authorization',
      value: 'token',
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
      name: 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader',
      value: 'some-value',
    });
  });
});

describe('parseHeaderFlags', () => {
  it('parses multiple headers', () => {
    const result = parseHeaderFlags(['MyHeader: value1', 'Authorization: Bearer token']);
    expect(result).toEqual({
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader': 'value1',
      Authorization: 'Bearer token',
    });
  });

  it('parses X- prefixed headers without prefixing', () => {
    const result = parseHeaderFlags(['X-Api-Key: key123', 'X-Custom-Signature: sha256=abc']);
    expect(result).toEqual({
      'X-Api-Key': 'key123',
      'X-Custom-Signature': 'sha256=abc',
    });
  });

  it('returns empty object for empty array', () => {
    expect(parseHeaderFlags([])).toEqual({});
  });

  it('last value wins for duplicate keys', () => {
    const result = parseHeaderFlags(['MyHeader: first', 'MyHeader: second']);
    expect(result).toEqual({
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader': 'second',
    });
  });

  it('throws on invalid format', () => {
    expect(() => parseHeaderFlags(['invalid-no-colon'])).toThrow('Invalid header format');
  });
});
