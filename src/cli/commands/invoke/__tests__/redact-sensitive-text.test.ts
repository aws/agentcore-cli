import { redactSensitiveText } from '../command.js';
import { describe, expect, it } from 'vitest';

describe('redactSensitiveText', () => {
  it('redacts Bearer tokens', () => {
    expect(redactSensitiveText('Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig')).toBe(
      'Authorization: Bearer [REDACTED]'
    );
  });

  it('redacts Bearer tokens in JSON', () => {
    expect(redactSensitiveText('{"header":"Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig"}')).toBe(
      '{"header":"Bearer [REDACTED]"}'
    );
  });

  it('redacts client_secret in key=value form', () => {
    expect(redactSensitiveText('client_secret=abc123def')).toBe('client_secret=[REDACTED]');
  });

  it('redacts client_secret in JSON form', () => {
    expect(redactSensitiveText('{"client_secret":"abc123def"}')).toBe('{"client_secret":"[REDACTED]"}');
  });

  it('redacts token in key=value form', () => {
    expect(redactSensitiveText('token=eyJhbGciOiJSUzI1NiJ9')).toBe('token=[REDACTED]');
  });

  it('redacts token in JSON form', () => {
    expect(redactSensitiveText('{"token":"eyJhbGciOiJSUzI1NiJ9"}')).toBe('{"token":"[REDACTED]"}');
  });

  it('redacts access_token in JSON form', () => {
    expect(redactSensitiveText('{"access_token":"jwt.token.here"}')).toBe('{"access_token":"[REDACTED]"}');
  });

  it('redacts client-secret with hyphen', () => {
    expect(redactSensitiveText('client-secret=mysecret')).toBe('client-secret=[REDACTED]');
  });

  it('does not modify text without sensitive content', () => {
    const input = 'Agent responded successfully with 200 OK';
    expect(redactSensitiveText(input)).toBe(input);
  });

  it('handles multiple sensitive values in one string', () => {
    const input = 'Bearer abc123 and client_secret=xyz789';
    expect(redactSensitiveText(input)).toBe('Bearer [REDACTED] and client_secret=[REDACTED]');
  });
});
