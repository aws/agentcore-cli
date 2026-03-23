import {
  HEADER_ALLOWLIST_PREFIX,
  MAX_HEADER_ALLOWLIST_SIZE,
  normalizeHeaderName,
  parseAndNormalizeHeaders,
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

  it('returns full header name as-is when prefix already present', () => {
    const fullHeader = 'X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader';
    expect(normalizeHeaderName(fullHeader)).toBe(fullHeader);
  });

  it('auto-prefixes a bare suffix like "MyHeader"', () => {
    expect(normalizeHeaderName('MyHeader')).toBe('X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader');
  });

  it('auto-prefixes suffix with hyphens like "My-Custom-Header"', () => {
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

  it('deduplicates after normalization', () => {
    const result = parseAndNormalizeHeaders('MyHeader, X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader');
    expect(result).toEqual(['X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader']);
  });

  it('deduplicates case-insensitive Authorization', () => {
    const result = parseAndNormalizeHeaders('authorization, Authorization, AUTHORIZATION');
    expect(result).toEqual(['Authorization']);
  });

  it('trims whitespace around values', () => {
    const result = parseAndNormalizeHeaders('  MyHeader  ,  authorization  ,  Another-Header  ');
    expect(result).toEqual([
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader',
      'Authorization',
      'X-Amzn-Bedrock-AgentCore-Runtime-Custom-Another-Header',
    ]);
  });
});

describe('validateHeaderAllowlist', () => {
  it('returns true for empty input', () => {
    expect(validateHeaderAllowlist('')).toBe(true);
    expect(validateHeaderAllowlist('   ')).toBe(true);
  });

  it('returns true for valid custom header suffix', () => {
    expect(validateHeaderAllowlist('MyHeader')).toBe(true);
  });

  it('returns true for valid full header name', () => {
    expect(validateHeaderAllowlist('X-Amzn-Bedrock-AgentCore-Runtime-Custom-MyHeader')).toBe(true);
  });

  it('returns true for "Authorization"', () => {
    expect(validateHeaderAllowlist('Authorization')).toBe(true);
    expect(validateHeaderAllowlist('authorization')).toBe(true);
  });

  it('returns true for mixed valid headers', () => {
    expect(validateHeaderAllowlist('Authorization, MyHeader, X-Amzn-Bedrock-AgentCore-Runtime-Custom-Another')).toBe(
      true
    );
  });

  it('returns error when exceeding max 20 headers', () => {
    const headers = Array.from({ length: 21 }, (_, i) => `Header${i}`).join(', ');
    const result = validateHeaderAllowlist(headers);
    expect(result).not.toBe(true);
    expect(result).toContain('20');
  });

  it('returns true for exactly 20 headers', () => {
    const headers = Array.from({ length: 20 }, (_, i) => `Header${i}`).join(', ');
    expect(validateHeaderAllowlist(headers)).toBe(true);
  });
});

describe('constants', () => {
  it('exports HEADER_ALLOWLIST_PREFIX', () => {
    expect(HEADER_ALLOWLIST_PREFIX).toBe('X-Amzn-Bedrock-AgentCore-Runtime-Custom-');
  });

  it('exports MAX_HEADER_ALLOWLIST_SIZE', () => {
    expect(MAX_HEADER_ALLOWLIST_SIZE).toBe(20);
  });
});
