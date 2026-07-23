import { containsSensitiveTestOutput, redactTestOutput, sensitiveEnvironmentValues } from './test-output-redaction';
import { describe, expect, it } from 'vitest';

describe('test output redaction', () => {
  it('redacts supported provider, AWS, and GitHub credential formats', () => {
    const credentials = [
      `AKIA${'A'.repeat(16)}`,
      `AIza${'b'.repeat(35)}`,
      `ghp_${'c'.repeat(36)}`,
      `github_pat_${'d'.repeat(32)}`,
      `sk-ant-${'e'.repeat(32)}`,
      `sk-proj-${'f'.repeat(32)}`,
      `eyJ${'g'.repeat(12)}.${'h'.repeat(12)}.${'i'.repeat(12)}`,
    ];

    const result = redactTestOutput(credentials.join('\n'));

    expect(result.redactions).toBe(credentials.length);
    for (const credential of credentials) {
      expect(result.text).not.toContain(credential);
    }
  });

  it('redacts private keys, bearer tokens, and credential assignments', () => {
    const privateKey = ['-----BEGIN PRIVATE KEY-----', 'not-real-key-material', '-----END PRIVATE KEY-----'].join('\n');
    const input = [privateKey, `Authorization: Bearer ${'a'.repeat(24)}`, `client_secret=${'b'.repeat(24)}`].join('\n');

    const result = redactTestOutput(input);

    expect(result.redactions).toBe(3);
    expect(result.text).not.toContain('not-real-key-material');
    expect(result.text).toContain('Authorization: Bearer [REDACTED]');
    expect(result.text).toContain('client_secret=[REDACTED]');
  });

  it('redacts exact environment secrets without treating identifiers as secrets', () => {
    const environment = {
      OPENAI_API_KEY: 'provider-value-without-a-known-prefix',
      APP_PRIVATE_KEY: 'private-key-value',
      CDP_API_KEY_ID: 'non-secret-identifier',
      APP_ID: 'non-secret-app-id',
      SHORT_TOKEN: 'short',
    };

    const secretValues = sensitiveEnvironmentValues(environment);
    const result = redactTestOutput(Object.values(environment).join(' '), secretValues);

    expect(secretValues).toEqual(['provider-value-without-a-known-prefix', 'private-key-value']);
    expect(result.text).not.toContain('provider-value-without-a-known-prefix');
    expect(result.text).not.toContain('private-key-value');
    expect(result.text).toContain('non-secret-identifier');
    expect(result.text).toContain('non-secret-app-id');
    expect(result.text).toContain('short');
  });

  it('leaves ordinary test output unchanged', () => {
    const input = 'Harness deployment completed in us-east-1';

    expect(redactTestOutput(input)).toEqual({ text: input, redactions: 0 });
    expect(containsSensitiveTestOutput(input)).toBe(false);
  });

  it('does not detect its own redaction marker', () => {
    const firstPass = redactTestOutput(`api_key=${'x'.repeat(32)}`);

    expect(firstPass.redactions).toBe(1);
    expect(redactTestOutput(firstPass.text)).toEqual({
      text: 'api_key=[REDACTED]',
      redactions: 0,
    });
  });
});
