import { redactSensitiveText } from '../command.js';
import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

const TEST_SIGNING_SECRET = new TextEncoder().encode('redaction-unit-test-signing-secret-0123456789');

async function makeJwt(claims: Record<string, unknown> = { sub: '1234567890', aud: 'client-abc' }): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(TEST_SIGNING_SECRET);
}

describe('redactSensitiveText', () => {
  let jwt: string;

  beforeAll(async () => {
    jwt = await makeJwt();
  });

  it('redacts Bearer tokens', () => {
    expect(redactSensitiveText(`Authorization: Bearer ${jwt}`)).toBe('Authorization: Bearer [REDACTED]');
  });

  it('redacts Bearer tokens in JSON', () => {
    expect(redactSensitiveText(`{"header":"Bearer ${jwt}"}`)).toBe('{"header":"Bearer [REDACTED]"}');
  });

  it('redacts a JWT by shape even without a "bearer"/key prefix', () => {
    expect(redactSensitiveText(`agent response: ${jwt}`)).toBe('agent response: [REDACTED]');
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

  it('handles multiple sensitive values in one string', () => {
    expect(redactSensitiveText(`Bearer ${jwt} and client_secret=xyz789`)).toBe(
      'Bearer [REDACTED] and client_secret=[REDACTED]'
    );
  });

  it('does not modify text without sensitive content', () => {
    const input = 'Agent responded successfully with 200 OK';
    expect(redactSensitiveText(input)).toBe(input);
  });

  it('does not redact the literal word "token" after "bearer"', () => {
    const input = "Agent 'E2eJwt123' is configured for CUSTOM_JWT but no bearer token is available.";
    expect(redactSensitiveText(input)).toBe(input);
  });

  it('does not redact prose like "Invalid Bearer Token"', () => {
    const input = 'Invalid Bearer Token';
    expect(redactSensitiveText(input)).toBe(input);
  });
});
